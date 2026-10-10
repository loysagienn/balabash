// The /api namespace over the stand (src/test-support/stand.ts): the
// projects endpoints write the row, the folder and the project.* event
// together and answer the console's shapes and refusals; PATCH /settings
// stores the names; a cross-site mutation is refused and the browser's
// own-origin one passes; a race of two creations leaves one row, and the
// folder is seeded by the creation that owns the row, never by the loser;
// the cache policy of the private surfaces: /api is no-store, the workspace
// bytes are revalidated by ETag, the stored files by id are kept for an hour.
//
// Run: npm test  (node:test, native type stripping — no build needed).

import { test, describe, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { STAND_HOST, startStand } from '../test-support/stand.ts';
import type { Reply, Stand } from '../test-support/stand.ts';
import type { CreateProjectResponse, ProjectResponse, SettingsResponse, MeResponse, WorkspaceNodeResponse } from './contract.ts';

type ErrorBody = { error: { code: string; message: string } };

let stand: Stand;
let prisma: typeof import('../db/client.ts')['prisma'];
let filesDir: string;

before(async () => {
  stand = await startStand();
  ({ prisma } = await import('../db/client.ts'));
  filesDir = (await import('../workspace/layout.ts')).workspaceFilesDir(stand.userId);
});

after(() => stand.stop());

async function projectEvents(): Promise<{ type: string; actor: string; threadId: string | null; id: string }[]> {
  const rows = await prisma.event.findMany({ where: { type: { startsWith: 'project.' } }, orderBy: { seq: 'asc' } });

  return rows.map(row => ({ type: row.type, actor: row.actor, threadId: row.threadId, id: (row.payload as { id: string }).id }));
}

describe('projects over the api', () => {
  let id: string;

  test('POST /projects creates the row, the folder and the event in one go', async () => {
    const reply = await stand.request('POST', '/api/projects', { body: { title: 'Renovation', slug: 'renovation', description: 'The flat.' } });

    assert.equal(reply.status, 200, reply.text);

    const { project, adopted } = reply.json<CreateProjectResponse>();

    id = project.id;
    assert.equal(adopted, false);
    assert.deepEqual(
      { ...project, id: 'id', createdAt: project.createdAt instanceof Date, updatedAt: project.updatedAt instanceof Date },
      { id: 'id', title: 'Renovation', slug: 'renovation', description: 'The flat.', archived: false, createdAt: true, updatedAt: true },
    );

    const row = await prisma.project.findUnique({ where: { id } });

    assert.equal(row?.userId, stand.userId);
    assert.equal(row?.slug, 'renovation');

    const dir = path.join(filesDir, 'renovation');

    assert.deepEqual((await fs.readdir(dir)).sort(), ['AGENTS.md', 'inbox.md', 'journal.md']);
    assert.match(await fs.readFile(path.join(dir, 'AGENTS.md'), 'utf8'), /^# Renovation\n\nThe flat\./);

    assert.deepEqual(await projectEvents(), [{ type: 'project.created', actor: 'user', threadId: null, id }]);
  });

  test('a taken slug or title is a conflict, a bad slug or a corrupted body a bad request', async () => {
    const slug = await stand.request('POST', '/api/projects', { body: { title: 'Other', slug: 'renovation', description: 'd' } });

    assert.equal(slug.status, 409);
    assert.match(slug.json<ErrorBody>().error.message, /slug "renovation" is already taken/);

    const title = await stand.request('POST', '/api/projects', { body: { title: 'Renovation', slug: 'other', description: 'd' } });

    assert.equal(title.status, 409);

    const bad = await stand.request('POST', '/api/projects', { body: { title: 'T', slug: 'Bad Slug', description: 'd' } });

    assert.equal(bad.status, 400);
    assert.equal(bad.json<ErrorBody>().error.code, 'bad_request');

    const corrupted = await stand.request('POST', '/api/projects', { text: '{"title": ' });

    assert.equal(corrupted.status, 400);

    assert.equal(await prisma.project.count(), 1);
    assert.equal((await projectEvents()).length, 1);
  });

  test('PATCH /projects/:id renames the folder with the slug and journals the update', async () => {
    const reply = await stand.request('PATCH', `/api/projects/${id}`, { body: { slug: 'flat', description: 'The flat, renovated.' } });

    assert.equal(reply.status, 200, reply.text);

    const { project } = reply.json<ProjectResponse>();

    assert.equal(project.slug, 'flat');
    assert.equal(project.description, 'The flat, renovated.');
    assert.equal(project.title, 'Renovation');

    assert.equal(await fs.stat(path.join(filesDir, 'renovation')).catch(() => null), null);
    assert.deepEqual((await fs.readdir(path.join(filesDir, 'flat'))).sort(), ['AGENTS.md', 'inbox.md', 'journal.md']);

    assert.deepEqual((await projectEvents()).map(event => event.type), ['project.created', 'project.updated']);
  });

  test('an empty PATCH is a touch; an unknown id is not found', async () => {
    const before = (await prisma.project.findUniqueOrThrow({ where: { id } })).updatedAt;
    const touch = await stand.request('PATCH', `/api/projects/${id}`);

    assert.equal(touch.status, 200, touch.text);
    assert.ok(touch.json<ProjectResponse>().project.updatedAt.getTime() >= before.getTime());

    const missing = await stand.request('PATCH', '/api/projects/no-such-project', { body: { title: 'X' } });

    assert.equal(missing.status, 404);
    assert.equal(missing.json<ErrorBody>().error.code, 'not_found');
  });

  test('archive flips the flag once and journals once; unarchive the same', async () => {
    const archived = await stand.request('POST', `/api/projects/${id}/archive`);

    assert.equal(archived.status, 200, archived.text);
    assert.equal(archived.json<ProjectResponse>().project.archived, true);

    const again = await stand.request('POST', `/api/projects/${id}/archive`);

    assert.equal(again.status, 200);
    assert.equal(again.json<ProjectResponse>().project.archived, true);

    const restored = await stand.request('POST', `/api/projects/${id}/unarchive`);

    assert.equal(restored.status, 200);
    assert.equal(restored.json<ProjectResponse>().project.archived, false);

    assert.equal((await prisma.project.findUniqueOrThrow({ where: { id } })).archived, false);
    assert.deepEqual(
      (await projectEvents()).map(event => event.type),
      ['project.created', 'project.updated', 'project.updated', 'project.archived', 'project.unarchived'],
    );
  });

  test('two creations of one slug at once: one row, one event, one conflict, and the folder seeded by the row’s creation', async () => {
    const replies = await Promise.all([
      stand.request('POST', '/api/projects', { body: { title: 'Race A', slug: 'race', description: 'The first body.' } }),
      stand.request('POST', '/api/projects', { body: { title: 'Race B', slug: 'race', description: 'The second body.' } }),
    ]);

    assert.deepEqual(replies.map(reply => reply.status).sort(), [200, 409]);

    const rows = await prisma.project.findMany({ where: { slug: 'race' } });

    assert.equal(rows.length, 1);
    assert.equal((await projectEvents()).filter(event => event.type === 'project.created').length, 2);

    // Whichever creation won the row seeded the folder with its own title
    // and description.
    const [row] = rows;

    assert.match(await fs.readFile(path.join(filesDir, 'race', 'AGENTS.md'), 'utf8'), new RegExp(`^# ${row.title}\\n\\n${row.description}\\n`));
  });

  // The loser of the race, caught in the act: the test holds an uncommitted
  // row of the slug in a transaction of its own, so the creation's friendly
  // check sees nothing and its insert waits on the unique index; once the
  // row commits the insert fails, and the loser must have written nothing to
  // the disk — before the seed moved into the transaction it wrote the three
  // files with its own title ahead of the row. Every wait is raced against
  // the failure of what it depends on, and the cleanup lets the transaction
  // go and aborts the request whatever happened.
  test('a creation losing the row to a concurrent one leaves no folder behind', { timeout: 30_000 }, async () => {
    let locked!: () => void;
    let lockLost!: (reason: unknown) => void;
    const rowHeld = new Promise<void>((resolve, reject) => {
      locked = resolve;
      lockLost = reject;
    });
    let release!: () => void;
    let abandon!: (reason: unknown) => void;
    const released = new Promise<void>((resolve, reject) => {
      release = resolve;
      abandon = reject;
    });

    // The cleanup abandons the barrier whether or not the transaction got
    // as far as waiting on it (its insert may have failed first): handled
    // here, so a barrier nobody waits on is not an unhandled rejection.
    released.catch(() => {});
    const held = prisma.$transaction(
      async tx => {
        await tx.project.create({ data: { userId: stand.userId, title: 'Held', slug: 'held', description: 'The row that wins.' } });
        locked();
        await released;
      },
      { timeout: 20_000 },
    );

    held.catch(lockLost);

    const aborter = new AbortController();
    const watching = new AbortController();
    let reply: Promise<Reply> | null = null;
    let waiter: Promise<void> | null = null;

    try {
      await rowHeld;
      reply = stand.request('POST', '/api/projects', { body: { title: 'Loser', slug: 'held', description: 'The body that loses.' }, signal: aborter.signal });
      waiter = waitForLockWaiter(watching.signal);
      await Promise.race([
        waiter,
        failureOf(held),
        reply.then(early => {
          throw new Error(`the creation answered before the row was committed: ${early.status} ${early.text}`);
        }),
      ]);
      release();
      await held;

      const refused = await reply;

      assert.equal(refused.status, 409, refused.text);
      assert.equal(refused.json<ErrorBody>().error.code, 'conflict');
      assert.equal(await fs.stat(path.join(filesDir, 'held')).catch(() => null), null);
      assert.equal((await prisma.project.findUniqueOrThrow({ where: { userId_slug: { userId: stand.userId, slug: 'held' } } })).title, 'Held');
      // The held row wrote no event of its own; the loser added none.
      assert.equal((await projectEvents()).filter(event => event.type === 'project.created').length, 2);
    } finally {
      // Every helper let go and awaited: the transaction, the request and
      // the observer, whichever of them the race left running.
      abandon(new Error('the scenario is over'));
      aborter.abort();
      watching.abort();
      await Promise.allSettled([held, reply, waiter]);
    }
  });

  // A creation that fails on the disk after part of its seed: the row and
  // the event roll back, and the files it wrote go with them — before the
  // rollback lets a concurrent creation of the slug in — so the next
  // creation of the slug seeds from its own body instead of adopting the
  // failed one's header. The disk failure is an injected one: the second
  // seed file refuses with ENOSPC.
  test('a creation failing on the disk after part of the seed leaves nothing, and the retry seeds its own files', async () => {
    const failed = await withSeedFailure('inbox.md', () =>
      stand.request('POST', '/api/projects', { body: { title: 'Partial A', slug: 'partial', description: 'The failed body.' } }),
    );

    assert.equal(failed.status, 500, failed.text);
    assert.equal(await prisma.project.count({ where: { slug: 'partial' } }), 0);
    assert.equal(await fs.stat(path.join(filesDir, 'partial')).catch(() => null), null);

    const retried = await stand.request('POST', '/api/projects', { body: { title: 'Partial B', slug: 'partial', description: 'The body that stays.' } });

    assert.equal(retried.status, 200, retried.text);
    assert.equal(retried.json<CreateProjectResponse>().adopted, false);
    assert.match(await fs.readFile(path.join(filesDir, 'partial', 'AGENTS.md'), 'utf8'), /^# Partial B\n\nThe body that stays\.\n/);
    assert.equal((await projectEvents()).filter(event => event.type === 'project.created' && event.id === retried.json<CreateProjectResponse>().project.id).length, 1);
  });

  test('a creation failing on the disk in an adopted folder takes back only its own files', async () => {
    const dir = path.join(filesDir, 'adopted');

    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'notes.md'), 'Someone’s work.\n');

    const failed = await withSeedFailure('journal.md', () =>
      stand.request('POST', '/api/projects', { body: { title: 'Adopted A', slug: 'adopted', description: 'The failed body.' } }),
    );

    assert.equal(failed.status, 500, failed.text);
    assert.deepEqual((await fs.readdir(dir)).sort(), ['notes.md']);
    assert.equal(await prisma.project.count({ where: { slug: 'adopted' } }), 0);

    const retried = await stand.request('POST', '/api/projects', { body: { title: 'Adopted B', slug: 'adopted', description: 'The body that stays.' } });

    assert.equal(retried.status, 200, retried.text);
    assert.equal(retried.json<CreateProjectResponse>().adopted, true);
    assert.deepEqual((await fs.readdir(dir)).sort(), ['AGENTS.md', 'inbox.md', 'journal.md', 'notes.md']);
    assert.match(await fs.readFile(path.join(dir, 'AGENTS.md'), 'utf8'), /^# Adopted B\n/);
    assert.equal(await fs.readFile(path.join(dir, 'notes.md'), 'utf8'), 'Someone’s work.\n');
  });
});

// Runs the action with the seed of the named file refused by the disk
// (ENOSPC) — the same fs.promises object createProject writes through; the
// other writes pass. Restored whatever happens.
async function withSeedFailure<T>(name: string, action: () => Promise<T>): Promise<T> {
  const original = fs.writeFile;
  const mocked = mock.method(fs, 'writeFile', (file: Parameters<typeof fs.writeFile>[0], ...rest: unknown[]) => {
    if (typeof file === 'string' && path.basename(file) === name) {
      return Promise.reject(Object.assign(new Error(`ENOSPC: no space left on device, open '${file}'`), { code: 'ENOSPC' }));
    }

    return (original as (...args: unknown[]) => Promise<void>).call(fs, file, ...rest);
  });

  try {
    return await action();
  } finally {
    mocked.mock.restore();
  }
}

describe('the cache policy of the private surfaces', () => {
  test('/api answers are never stored, the refusals included', async () => {
    const me = await stand.request('GET', '/api/me');

    assert.equal(me.status, 200);
    assert.equal(me.headers['cache-control'], 'no-store');

    const threads = await stand.request('GET', '/api/threads?limit=1');

    assert.equal(threads.status, 200, threads.text);
    assert.equal(threads.headers['cache-control'], 'no-store');

    const unknown = await stand.request('GET', '/api/nothing-here');

    assert.equal(unknown.status, 404);
    assert.equal(unknown.headers['cache-control'], 'no-store');

    const signedOut = await stand.request('GET', '/api/me', { cookie: '' });

    assert.equal(signedOut.status, 401);
    assert.equal(signedOut.headers['cache-control'], 'no-store');
  });

  test('a stored file by id may be kept privately for an hour', async () => {
    const { ingestFile } = await import('../files/index.ts');
    const file = await ingestFile({ body: Buffer.from('stored'), contentType: 'text/plain', sizeBytes: 6, originalFilename: 'note.txt', userId: stand.userId });
    const reply = await stand.request('GET', `/api/files/${file.id}`);

    assert.equal(reply.status, 200, reply.text);
    assert.equal(reply.text, 'stored');
    assert.equal(reply.headers['cache-control'], 'private, max-age=3600');
  });

  test('the workspace bytes are revalidated by ETag: 304 while the file holds, the bytes again once it changed', async () => {
    const file = path.join(filesDir, 'notes', 'todo.md');

    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, '# Todo\n');

    const first = await stand.request('GET', '/files/notes/todo.md');

    assert.equal(first.status, 200, first.text);
    assert.equal(first.text, '# Todo\n');
    assert.equal(first.headers['cache-control'], 'private, no-cache');
    assert.match(first.headers.etag ?? '', /^W\/"[0-9a-f]+-[0-9a-f]+-[0-9a-f]+"$/);

    const same = await stand.request('GET', '/files/notes/todo.md', { headers: { 'if-none-match': first.headers.etag as string } });

    assert.equal(same.status, 304);
    assert.equal(same.text, '');
    assert.equal(same.headers.etag, first.headers.etag);
    assert.equal(same.headers['cache-control'], 'private, no-cache');

    await fs.writeFile(file, '# Todo\n\n- one\n');

    const changed = await stand.request('GET', '/files/notes/todo.md', { headers: { 'if-none-match': first.headers.etag as string } });

    assert.equal(changed.status, 200);
    assert.equal(changed.text, '# Todo\n\n- one\n');
    assert.notEqual(changed.headers.etag, first.headers.etag);

    const missing = await stand.request('GET', '/files/notes/nothing.md');

    assert.equal(missing.status, 404);
    assert.equal(missing.headers['cache-control'], 'no-store');
  });

  // A restore or a copy that keeps the times (cp -p, rsync -a, tar) can
  // replace the content without moving the size or the modification time;
  // the validator must still tell the new bytes from the old ones.
  test('the ETag tells content apart when the size and the modification time are kept', async () => {
    const file = path.join(filesDir, 'notes', 'kept.txt');
    const kept = new Date('2026-01-02T03:04:05.678Z');

    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, 'old');
    await fs.utimes(file, kept, kept);

    const first = await stand.request('GET', '/files/notes/kept.txt');

    assert.equal(first.status, 200, first.text);
    assert.equal(first.text, 'old');

    const before = await fs.stat(file, { bigint: true });

    // The kernel's file clock is coarse (a tick); let it move on.
    await new Promise(resolve => setTimeout(resolve, 10));
    await fs.writeFile(file, 'new');
    await fs.utimes(file, kept, kept);

    const after = await fs.stat(file, { bigint: true });

    assert.equal(after.size, before.size);
    assert.equal(after.mtimeMs, before.mtimeMs);

    const revalidated = await stand.request('GET', '/files/notes/kept.txt', { headers: { 'if-none-match': first.headers.etag as string } });

    assert.equal(revalidated.status, 200);
    assert.equal(revalidated.text, 'new');
    assert.notEqual(revalidated.headers.etag, first.headers.etag);
  });

  // A stored file the storage refuses to open after the owner check (a
  // transient failure of the store, a row pointing nowhere) is a 500, and
  // the error must not inherit the hour of the bytes nor their disposition.
  test('a stored file that cannot be opened is a 500 that is never stored', async () => {
    const { ingestFile } = await import('../files/index.ts');
    const file = await ingestFile({ body: Buffer.from('gone'), contentType: 'text/plain', sizeBytes: 4, originalFilename: 'gone.txt', userId: stand.userId });

    await prisma.file.update({ where: { id: file.id }, data: { objectKey: '../outside-the-root' } });

    const reply = await stand.request('GET', `/api/files/${file.id}`);

    assert.equal(reply.status, 500, reply.text);
    assert.equal(reply.json<ErrorBody>().error.code, 'internal_error');
    assert.equal(reply.headers['cache-control'], 'no-store');
    assert.equal(reply.headers['content-disposition'], undefined);
    assert.match(reply.headers['content-type'] ?? '', /^application\/json/);
  });
});

// A promise that rejects when the given one does and never resolves — to
// race a wait against the failure of what it depends on.
function failureOf(promise: Promise<unknown>): Promise<never> {
  return promise.then(() => new Promise<never>(() => {}));
}

// Until a session of the stand's database waits for a lock — the creation's
// insert blocked on the unique index behind the row the test holds — or
// until told to stop (the scenario ended another way): the polling must not
// outlive the test and the stand.
async function waitForLockWaiter(signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + 10_000;

  while (!signal.aborted && Date.now() < deadline) {
    const [row] = await prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;

    if (row && row.n > 0) {
      return;
    }

    await new Promise(resolve => setTimeout(resolve, 20));
  }

  if (!signal.aborted) {
    assert.fail('the creation never waited for the row');
  }
}

describe('the workspace node over the api', () => {
  test('a folder answers its files and the facts of its folders: the folder’s own time and the count of its direct children', async () => {
    const root = path.join(filesDir, 'node-probe');

    try {
      await fs.mkdir(path.join(root, 'full', 'inner', 'deeper'), { recursive: true });
      await fs.mkdir(path.join(root, 'empty'), { recursive: true });
      await fs.writeFile(path.join(root, 'full', 'a.md'), '# A\n');
      await fs.writeFile(path.join(root, 'full', 'b.txt'), 'b');
      await fs.writeFile(path.join(root, 'full', 'inner', 'c.txt'), 'c');
      // Neither a directory nor a regular file: the listing's rule leaves it out of both counts.
      await fs.symlink(path.join(root, 'full', 'a.md'), path.join(root, 'full', 'link.md'));
      await fs.writeFile(path.join(root, 'top.md'), 'top\n');
      // Times set apart on purpose, so that the answer tells the folder's own
      // mtime from any child's whatever the clock's grain: the folder in
      // March, a child in June — later than the folder.
      const folderTime = new Date(2026, 2, 3, 10, 0, 0);
      const childTime = new Date(2026, 5, 6, 12, 0, 0);

      await fs.utimes(path.join(root, 'full', 'a.md'), childTime, childTime);
      await fs.utimes(path.join(root, 'full'), folderTime, folderTime);

      const [empty, full] = await Promise.all([fs.stat(path.join(root, 'empty')), fs.stat(path.join(root, 'full'))]);

      assert.equal(full.mtime.toISOString(), folderTime.toISOString());
      const reply = await stand.request('GET', '/api/workspace/node?path=node-probe');

      assert.equal(reply.status, 200, reply.text);
      const node = reply.json<WorkspaceNodeResponse>();

      assert.equal(node.kind, 'dir');
      if (node.kind !== 'dir') return;
      assert.equal(node.path, 'node-probe');
      assert.deepEqual(node.directories, ['empty', 'full']);
      assert.deepEqual(node.folders, [
        { path: 'node-probe/empty', modifiedAt: empty.mtime.toISOString(), directoryCount: 0, fileCount: 0 },
        { path: 'node-probe/full', modifiedAt: full.mtime.toISOString(), directoryCount: 1, fileCount: 2 },
      ]);
      assert.deepEqual(node.files.map(file => file.path), ['node-probe/top.md']);

      // A file changing inside a folder moves neither the folder's time nor
      // its counts: the child's mtime is now the present, months past the
      // folder's, and the folder still answers March.
      await fs.writeFile(path.join(root, 'full', 'a.md'), '# A\n\nmore\n');
      assert.ok((await fs.stat(path.join(root, 'full', 'a.md'))).mtime.getTime() > folderTime.getTime());
      const again = (await stand.request('GET', '/api/workspace/node?path=node-probe')).json<WorkspaceNodeResponse>();

      assert.equal(again.kind, 'dir');
      if (again.kind !== 'dir') return;
      assert.deepEqual(again.folders, node.folders);

      // Seen from the root, the probe is one folder with its own direct children.
      const top = (await stand.request('GET', '/api/workspace/node?path=')).json<WorkspaceNodeResponse>();

      assert.equal(top.kind, 'dir');
      if (top.kind !== 'dir') return;
      const probe = top.folders.find(folder => folder.path === 'node-probe');

      assert.ok(probe, 'the probe folder is listed at the root');
      assert.deepEqual({ directoryCount: probe.directoryCount, fileCount: probe.fileCount }, { directoryCount: 2, fileCount: 1 });
      assert.equal(top.directories.includes('node-probe'), true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  // The two reads of a folder fail into their own nulls — through the same
  // fs.promises object listDir reads with, the failure by the folder's name,
  // the other folders read as ever; restored whatever happens.
  test('a folder’s facts are null each by its own failed read: no readdir — the date with unknown counts, no stat — the counts without a date, vanished — all null', async () => {
    const root = path.join(filesDir, 'fail-probe');
    const failing = (code: string, folders: Set<string>, original: (...args: unknown[]) => Promise<unknown>) =>
      (file: unknown, ...rest: unknown[]) => {
        if (typeof file === 'string' && path.dirname(file) === root && folders.has(path.basename(file))) {
          return Promise.reject(Object.assign(new Error(`${code}: '${file}'`), { code }));
        }

        return original.call(fs, file, ...rest);
      };
    const originalStat = fs.stat as (...args: unknown[]) => Promise<unknown>;
    const originalReaddir = fs.readdir as (...args: unknown[]) => Promise<unknown>;
    const stat = mock.method(fs, 'stat', failing('ENOENT', new Set(['gone', 'unstatable']), originalStat) as typeof fs.stat);
    const readdir = mock.method(fs, 'readdir', failing('EACCES', new Set(['gone', 'unreadable']), originalReaddir) as typeof fs.readdir);

    try {
      for (const name of ['gone', 'unreadable', 'unstatable', 'plain']) {
        await fs.mkdir(path.join(root, name), { recursive: true });
      }
      await fs.writeFile(path.join(root, 'unreadable', 'hidden.md'), 'x');
      await fs.writeFile(path.join(root, 'unstatable', 'seen.md'), 'x');
      await fs.writeFile(path.join(root, 'plain', 'seen.md'), 'x');
      const kept = new Date(2026, 0, 2, 3, 4, 5);

      await fs.utimes(path.join(root, 'unreadable'), kept, kept);

      const reply = await stand.request('GET', '/api/workspace/node?path=fail-probe');

      assert.equal(reply.status, 200, reply.text);
      const node = reply.json<WorkspaceNodeResponse>();

      assert.equal(node.kind, 'dir');
      if (node.kind !== 'dir') return;
      assert.deepEqual(node.directories, ['gone', 'plain', 'unreadable', 'unstatable']);
      const plain = await originalStat(path.join(root, 'plain')) as { mtime: Date };

      assert.deepEqual(node.folders, [
        { path: 'fail-probe/gone', modifiedAt: null, directoryCount: null, fileCount: null },
        { path: 'fail-probe/plain', modifiedAt: plain.mtime.toISOString(), directoryCount: 0, fileCount: 1 },
        { path: 'fail-probe/unreadable', modifiedAt: kept.toISOString(), directoryCount: null, fileCount: null },
        { path: 'fail-probe/unstatable', modifiedAt: null, directoryCount: 0, fileCount: 1 },
      ]);
      // The failures were the folders' own, not the listing's.
      assert.ok(stat.mock.calls.length >= 4 && readdir.mock.calls.length >= 4);
    } finally {
      stat.mock.restore();
      readdir.mock.restore();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe('settings over the api', () => {
  test('PATCH /settings stores the names and /me reads them back', async () => {
    const reply = await stand.request('PATCH', '/api/settings', { body: { workspaceName: '  Home  ', operatorName: 'Vladimir' } });

    assert.equal(reply.status, 200, reply.text);
    assert.deepEqual(reply.json<SettingsResponse>(), { settings: { workspaceName: 'Home', operatorName: 'Vladimir' } });

    const me = await stand.request('GET', '/api/me');

    assert.deepEqual(me.json<MeResponse>(), { userId: stand.userId, workspaceName: 'Home', operatorName: 'Vladimir', mainThreadId: stand.mainThreadId });

    const cleared = await stand.request('PATCH', '/api/settings', { body: { operatorName: '   ' } });

    assert.deepEqual(cleared.json<SettingsResponse>(), { settings: { workspaceName: 'Home', operatorName: null } });

    const user = await prisma.user.findUniqueOrThrow({ where: { id: stand.userId } });

    assert.deepEqual({ workspaceName: user.workspaceName, operatorName: user.operatorName }, { workspaceName: 'Home', operatorName: null });
  });

  test('a field of another type is refused and nothing is written', async () => {
    const reply = await stand.request('PATCH', '/api/settings', { body: { workspaceName: 5 } });

    assert.equal(reply.status, 400);
    assert.match(reply.json<ErrorBody>().error.message, /workspaceName must be a string/);
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: stand.userId } })).workspaceName, 'Home');
  });
});

describe('the api as a whole', () => {
  test('a mutation from another origin is refused before any logic', async () => {
    const reply = await stand.request('POST', '/api/projects', {
      body: { title: 'Foreign', slug: 'foreign', description: 'd' },
      headers: { origin: 'https://evil.example' },
    });

    assert.equal(reply.status, 403);
    assert.equal(reply.json<ErrorBody>().error.code, 'cross_site');
    assert.equal(await prisma.project.count({ where: { slug: 'foreign' } }), 0);

    const own = await stand.request('GET', '/api/me', { headers: { origin: 'https://evil.example' } });

    assert.equal(own.status, 200);
  });

  test('a mutation the browser marks as the api’s own passes; one it marks cross-site is refused', async () => {
    // The stand's requests carry neither header by default (a script
    // holding the cookie on purpose); these are the browser's branches.
    const fetchMetadata = await stand.request('PATCH', '/api/settings', { body: {}, headers: { 'sec-fetch-site': 'same-origin', origin: `https://${STAND_HOST}` } });

    assert.equal(fetchMetadata.status, 200, fetchMetadata.text);

    const originOnly = await stand.request('PATCH', '/api/settings', { body: {}, headers: { origin: `https://${STAND_HOST}` } });

    assert.equal(originOnly.status, 200, originOnly.text);

    const crossSite = await stand.request('PATCH', '/api/settings', { body: {}, headers: { 'sec-fetch-site': 'cross-site', origin: `https://${STAND_HOST}` } });

    assert.equal(crossSite.status, 403);
    assert.equal(crossSite.json<ErrorBody>().error.code, 'cross_site');
  });

  test('an unknown endpoint answers JSON 404', async () => {
    const reply = await stand.request('GET', '/api/nothing-here');

    assert.equal(reply.status, 404);
    assert.equal(reply.json<ErrorBody>().error.code, 'not_found');
  });
});
