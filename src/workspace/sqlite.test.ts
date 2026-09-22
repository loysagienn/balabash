// Targeted tests of the platform's SQLite lock policy (sqlite.ts) and its
// two consumers: in-process metadata handles (files.ts) and the SQL child
// runner (child.ts). Every test stands up a real foreign writer — a separate
// node process holding BEGIN IMMEDIATE on a scratch database — because the
// point is surviving a lock held by another OS process.
//
// Run: npm test  (node:test, native type stripping — no build needed).

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { BUSY_SLICE_MS, LOCK_WAIT_MS, WorkspaceDbBusyError, childBusyTimeoutMs, inWriteTransaction, isBusyError, withWorkspaceDb } from './sqlite.ts';
import { queryInChild, statementInChild } from './child.ts';
import { deleteMeta, ensureFilesDb, listDir, readMeta, upsertMeta } from './files.ts';
import { workspaceDbPath, workspaceFilesDir } from './layout.ts';

let root: string;
let dbPath: string;

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'balabash-sqlite-test-'));
  dbPath = path.join(root, 'workspace.sqlite');
  await ensureFilesDb(dbPath);
});

after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

// A foreign writer: holds BEGIN IMMEDIATE for holdMs, then commits. Resolves
// once the lock is actually taken (the child prints 'locked').
function holdWriteLock(holdMs: number, target = dbPath): Promise<ChildProcess> {
  const program = `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(process.argv[1], { timeout: 10000 });
    db.exec('BEGIN IMMEDIATE');
    process.stdout.write('locked\\n');
    setTimeout(() => { db.exec('COMMIT'); db.close(); }, Number(process.argv[2]));
  `;
  const child = spawn(process.execPath, ['-e', program, target, String(holdMs)], { stdio: ['ignore', 'pipe', 'inherit'] });

  return new Promise((resolve, reject) => {
    child.stdout.once('data', () => resolve(child));
    child.once('exit', code => reject(new Error(`holder exited early with ${code}`)));
  });
}

function waitExit(child: ChildProcess): Promise<void> {
  return new Promise(resolve => (child.exitCode !== null ? resolve() : child.once('exit', () => resolve())));
}

// Samples event-loop responsiveness: the longest gap between 10 ms ticks.
function loopLagProbe(): { stop: () => number } {
  let last = Date.now();
  let worst = 0;
  const timer = setInterval(() => {
    const now = Date.now();
    worst = Math.max(worst, now - last);
    last = now;
  }, 10);

  return {
    stop: () => {
      clearInterval(timer);
      return worst;
    },
  };
}

describe('policy constants', () => {
  test('a child waits as long as the policy allows but clear of its kill timeout', () => {
    assert.equal(childBusyTimeoutMs(60_000), LOCK_WAIT_MS);
    assert.equal(childBusyTimeoutMs(10_000), 5_000);
    assert.equal(childBusyTimeoutMs(2_000), 1_000);
    assert.ok(childBusyTimeoutMs(60_000) < 60_000);
  });

  test('isBusyError recognizes SQLITE_BUSY by code and by message', () => {
    const byCode = Object.assign(new Error('x'), { errcode: 5 });
    const extended = Object.assign(new Error('x'), { errcode: 261 }); // SQLITE_BUSY_RECOVERY
    assert.equal(isBusyError(byCode), true);
    assert.equal(isBusyError(extended), true);
    assert.equal(isBusyError(new Error('database is locked')), true);
    assert.equal(isBusyError(Object.assign(new Error('no such table'), { errcode: 1 })), false);
    assert.equal(isBusyError('nope'), false);
  });
});

describe('in-process handle (withWorkspaceDb)', () => {
  test('a write outwaits a foreign lock without freezing the event loop', async () => {
    const holder = await holdWriteLock(1_500);
    const probe = loopLagProbe();
    const startedAt = Date.now();

    const meta = await upsertMeta(dbPath, 'notes/a.md', 'A', null);
    const elapsed = Date.now() - startedAt;
    const worstLag = probe.stop();
    await waitExit(holder);

    assert.deepEqual(meta, { title: 'A', description: null });
    assert.ok(elapsed >= 1_000, `waited for the holder (${elapsed} ms)`);
    // Each attempt blocks for at most one busy slice (plus scheduling noise).
    assert.ok(worstLag < BUSY_SLICE_MS * 4, `event loop stayed responsive (worst gap ${worstLag} ms)`);
  });

  test('gives up with WorkspaceDbBusyError once the lock window is exhausted', async () => {
    const holder = await holdWriteLock(2_000);
    const startedAt = Date.now();

    await assert.rejects(
      withWorkspaceDb(dbPath, db => db.exec("INSERT INTO _files (path, updated_at) VALUES ('x', '')"), { lockWaitMs: 600 }),
      (error: unknown) => error instanceof WorkspaceDbBusyError && isBusyError(error.cause),
    );

    const elapsed = Date.now() - startedAt;
    await waitExit(holder);

    assert.ok(elapsed >= 600 && elapsed < 1_800, `respected the window (${elapsed} ms)`);
    // Nothing leaked from the failed attempts.
    const row = new DatabaseSync(dbPath).prepare("SELECT count(*) AS n FROM _files WHERE path = 'x'").get() as { n: number };
    assert.equal(row.n, 0);
  });

  test('non-busy errors propagate untouched and immediately', async () => {
    const startedAt = Date.now();
    await assert.rejects(
      withWorkspaceDb(dbPath, db => db.exec('SELECT * FROM no_such_table')),
      /no such table/,
    );
    assert.ok(Date.now() - startedAt < 500);
  });

  test('inWriteTransaction commits as one unit and rolls back on throw', async () => {
    await withWorkspaceDb(dbPath, db =>
      inWriteTransaction(db, () => {
        db.exec("INSERT INTO _files (path, updated_at) VALUES ('t1', '')");
        db.exec("INSERT INTO _files (path, updated_at) VALUES ('t2', '')");
      }),
    );

    await assert.rejects(
      withWorkspaceDb(dbPath, db =>
        inWriteTransaction(db, () => {
          db.exec("INSERT INTO _files (path, updated_at) VALUES ('t3', '')");
          throw new Error('boom');
        }),
      ),
      /boom/,
    );

    const rows = await withWorkspaceDb(dbPath, db =>
      (db.prepare("SELECT path FROM _files WHERE path LIKE 't_' ORDER BY path").all() as Array<{ path: string }>).map(r => r.path),
    );
    assert.deepEqual(rows, ['t1', 't2']);
  });
});

describe('_files metadata under a foreign lock', () => {
  test('listDir prunes orphans in one transaction while a writer is busy', async () => {
    // layout.ts resolves from cwd — point it at the scratch root.
    const previousCwd = process.cwd();
    const userId = 'u1';
    await fs.mkdir(path.join(root, 'data', 'workspace'), { recursive: true });
    process.chdir(root);

    try {
      const userDb = workspaceDbPath(userId);
      await fs.mkdir(workspaceFilesDir(userId), { recursive: true });
      await fs.writeFile(path.join(workspaceFilesDir(userId), 'keep.txt'), 'k');
      await ensureFilesDb(userDb);
      await upsertMeta(userDb, 'keep.txt', 'Keep', null);
      await upsertMeta(userDb, 'gone1.txt', 'Gone', null);
      await upsertMeta(userDb, 'gone2.txt', 'Gone', null);

      const userHolder = await holdWriteLock(1_200, userDb);

      const listing = await listDir(userId, '');
      await waitExit(userHolder);

      assert.deepEqual(listing?.files.map(f => f.path), ['keep.txt']);
      const left = await withWorkspaceDb(userDb, db =>
        (db.prepare('SELECT path FROM _files ORDER BY path').all() as Array<{ path: string }>).map(r => r.path),
      );
      assert.deepEqual(left, ['keep.txt']);

      await deleteMeta(userId, ['keep.txt']);
      const meta = await withWorkspaceDb(userDb, db => readMeta(db, 'keep.txt'));
      assert.deepEqual(meta, { title: null, description: null });

      // Pruning is best-effort: a lock outlasting its short window leaves the
      // orphan rows to the indexer, and the listing still answers promptly.
      await upsertMeta(userDb, 'gone3.txt', 'Gone', null);
      const longHolder = await holdWriteLock(3_500, userDb);
      const startedAt = Date.now();
      const listingUnderLock = await listDir(userId, '');
      const elapsed = Date.now() - startedAt;
      await waitExit(longHolder);

      assert.deepEqual(listingUnderLock?.files.map(f => f.path), ['keep.txt']);
      assert.ok(elapsed >= 2_000 && elapsed < 3_400, `gave up pruning after its window (${elapsed} ms)`);
      const leftover = await withWorkspaceDb(userDb, db =>
        (db.prepare('SELECT path FROM _files ORDER BY path').all() as Array<{ path: string }>).map(r => r.path),
      );
      assert.deepEqual(leftover, ['gone3.txt']);
    } finally {
      process.chdir(previousCwd);
    }
  });
});

describe('SQL child runner (data_query / app endpoints)', () => {
  const caps = { maxRows: 10, maxBytes: 10_000, timeoutMs: 8_000 };

  test('data_query write outwaits a foreign lock longer than the old 5 s', async () => {
    const holder = await holdWriteLock(6_000);
    const startedAt = Date.now();

    const outcome = await queryInChild(dbPath, root, "INSERT INTO _files (path, updated_at) VALUES ('q1', '')", {
      ...caps,
      timeoutMs: 20_000,
    });
    const elapsed = Date.now() - startedAt;
    await waitExit(holder);

    assert.equal(outcome.status, 'ok');
    assert.ok(elapsed >= 5_000, `waited through the 6 s lock (${elapsed} ms)`);
  });

  test('an app endpoint statement waits as well', async () => {
    const holder = await holdWriteLock(1_500);

    const outcome = await statementInChild(dbPath, root, {
      statement: 'INSERT INTO _files (path, updated_at) VALUES (@path, @at)',
      kind: 'run',
      params: { path: 'ep1', at: '' },
    }, caps);
    await waitExit(holder);

    assert.equal(outcome.status, 'ok');
    assert.equal(outcome.status === 'ok' && outcome.result.changes, 1);
  });

  test('a lock outlasting the window is a clear SQL error, not a kill', async () => {
    const holder = await holdWriteLock(3_000);

    // timeoutMs 2 000 → busy timeout 1 000 (the floor), kill at 2 000.
    const outcome = await queryInChild(dbPath, root, "INSERT INTO _files (path, updated_at) VALUES ('q2', '')", {
      ...caps,
      timeoutMs: 2_000,
    });
    await waitExit(holder);

    assert.equal(outcome.status, 'sql_error');
    assert.match(outcome.status === 'sql_error' ? outcome.message : '', /database is locked.*another writer.*1s/);
  });

  test('reads never wait under WAL', async () => {
    const holder = await holdWriteLock(2_000);
    const startedAt = Date.now();

    const outcome = await queryInChild(dbPath, root, 'SELECT count(*) AS n FROM _files', caps);
    const elapsed = Date.now() - startedAt;
    await waitExit(holder);

    assert.equal(outcome.status, 'ok');
    assert.ok(elapsed < 1_500, `a WAL read did not wait for the writer (${elapsed} ms)`);
  });
});
