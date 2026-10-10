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
import http from 'node:http';
import path from 'node:path';
import { STAND_HOST, sessionCookie, startStand } from '../test-support/stand.ts';
import type { Reply, Stand } from '../test-support/stand.ts';
import type { CreateProjectResponse, FileMetaResponse, LimitsResponse, ProjectResponse, SettingsFactsResponse, SettingsResponse, MeResponse, WorkspaceNodeResponse, WorkspaceWriteResponse } from './contract.ts';

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
      { id: 'id', title: 'Renovation', slug: 'renovation', description: 'The flat.', archived: false, archivedAt: null, createdAt: true, updatedAt: true },
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

  test('archive flips the flag once, stamps the date and journals once; unarchive clears the date the same way', async () => {
    const before = Date.now();
    const archived = await stand.request('POST', `/api/projects/${id}/archive`);

    assert.equal(archived.status, 200, archived.text);

    const stamped = archived.json<ProjectResponse>().project;

    assert.equal(stamped.archived, true);
    assert.ok(stamped.archivedAt instanceof Date && stamped.archivedAt.getTime() >= before - 1_000 && stamped.archivedAt.getTime() <= Date.now(), `archivedAt ${String(stamped.archivedAt)}`);

    const again = await stand.request('POST', `/api/projects/${id}/archive`);

    assert.equal(again.status, 200);
    assert.equal(again.json<ProjectResponse>().project.archived, true);
    assert.equal(again.json<ProjectResponse>().project.archivedAt?.getTime(), stamped.archivedAt?.getTime(), 'already archived: the date is not re-stamped');

    const restored = await stand.request('POST', `/api/projects/${id}/unarchive`);

    assert.equal(restored.status, 200);
    assert.equal(restored.json<ProjectResponse>().project.archived, false);
    assert.equal(restored.json<ProjectResponse>().project.archivedAt, null);

    const row = await prisma.project.findUniqueOrThrow({ where: { id } });

    assert.deepEqual({ archived: row.archived, archivedAt: row.archivedAt }, { archived: false, archivedAt: null });
    assert.deepEqual(
      (await projectEvents()).map(event => event.type),
      ['project.created', 'project.updated', 'project.updated', 'project.archived', 'project.unarchived'],
    );

    // The events carry the date as the row had it at each change.
    const flips = await prisma.event.findMany({ where: { type: { in: ['project.archived', 'project.unarchived'] } }, orderBy: { seq: 'asc' } });

    assert.deepEqual(
      flips.map(event => (event.payload as { archived: boolean; archivedAt: string | null }).archivedAt),
      [stamped.archivedAt?.toISOString(), null],
    );
  });

  // Two archives of one project at once: both read the live row before the
  // transaction, so the second must not re-stamp the date the first set, nor
  // journal a second archiving. The first is caught in the act — the test
  // holds the archived row uncommitted in a transaction of its own, so the
  // request's check sees a live project and its update waits on the row;
  // once the row commits the request's turn comes with nothing left to do:
  // the first date stays, one event, the answer tells the state as it is.
  // The same for two unarchives.
  for (const archived of [true, false]) {
    const flip = archived ? 'archive' : 'unarchive';

    test(`a ${flip} racing a concurrent one changes nothing: the first date and one event`, { timeout: 30_000 }, async () => {
      const { appendEventIn } = await import('../core/append.ts');
      const { projectRecord } = await import('../projects/store.ts');
      const firstAt = archived ? new Date('2026-03-04T05:06:07.890Z') : null;
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

      released.catch(() => {});
      const held = prisma.$transaction(
        async tx => {
          const row = await tx.project.update({ where: { id }, data: { archived, archivedAt: firstAt } });

          await appendEventIn(tx, { type: archived ? 'project.archived' : 'project.unarchived', actor: 'user', threadId: null, userId: stand.userId, payload: projectRecord(row) });
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
        reply = stand.request('POST', `/api/projects/${id}/${flip}`, { signal: aborter.signal });
        waiter = waitForLockWaiter(watching.signal);
        await Promise.race([
          waiter,
          failureOf(held),
          reply.then(early => {
            throw new Error(`the ${flip} answered before the row was committed: ${early.status} ${early.text}`);
          }),
        ]);
        release();
        await held;

        const late = await reply;

        assert.equal(late.status, 200, late.text);
        assert.equal(late.json<ProjectResponse>().project.archived, archived);
        assert.equal(late.json<ProjectResponse>().project.archivedAt?.getTime() ?? null, firstAt?.getTime() ?? null, 'the answer tells the date the first flip set');

        const row = await prisma.project.findUniqueOrThrow({ where: { id } });

        assert.equal(row.archivedAt?.getTime() ?? null, firstAt?.getTime() ?? null, 'the first date stays');
        assert.equal((await projectEvents()).filter(event => event.type === `project.${archived ? 'archived' : 'unarchived'}` && event.id === id).length, 2, 'one event per flip: the earlier test’s and the held one — the late request added none');
      } finally {
        abandon(new Error('the scenario is over'));
        aborter.abort();
        watching.abort();
        await Promise.allSettled([held, reply, waiter]);
      }
    });
  }

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

// Runs the action with the file row refused by the database (the client
// reporting a lost connection): the `file` delegate the files layer reads
// through is replaced on the client for the duration — the client is a
// proxy whose model properties are not methods of their own, so
// mock.method has nothing to take — and put back whatever happens.
async function withFileLookupFailure<T>(action: () => Promise<T>): Promise<T> {
  const original = prisma.file;
  const refusing = { findUnique: () => Promise.reject(new Error("Can't reach database server")) };

  assert.ok(Reflect.set(prisma, 'file', refusing));
  assert.equal(prisma.file, refusing);

  try {
    return await action();
  } finally {
    Reflect.set(prisma, 'file', original);
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

  test('the facts of a stored file by id: own — kept for an hour; foreign and missing — the same 404', async () => {
    const { ingestFile } = await import('../files/index.ts');
    const own = await ingestFile({ body: Buffer.from('<png>'), contentType: 'image/png', sizeBytes: 5, originalFilename: 'shot.png', width: 32, height: 16, userId: stand.userId });
    const foreign = await ingestFile({ body: Buffer.from('theirs'), contentType: 'text/plain', sizeBytes: 6, originalFilename: 'theirs.txt', userId: 'someone-else' });

    const reply = await stand.request('GET', `/api/files/${own.id}/meta`);

    assert.equal(reply.status, 200, reply.text);
    assert.deepEqual(reply.json<FileMetaResponse>(), { file: { fileId: own.id, name: 'shot.png', contentType: 'image/png', sizeBytes: 5, width: 32, height: 16 } });
    assert.equal(reply.headers['cache-control'], 'private, max-age=3600');

    const nameless = await ingestFile({ body: Buffer.from('?'), userId: stand.userId });
    const bare = await stand.request('GET', `/api/files/${nameless.id}/meta`);

    assert.equal(bare.status, 200, bare.text);
    // The size is the store's to record at ingest (the local driver counts the bytes); the rest is unknown.
    assert.deepEqual(bare.json<FileMetaResponse>().file, { fileId: nameless.id, name: null, contentType: null, sizeBytes: nameless.sizeBytes, width: null, height: null });

    for (const id of [foreign.id, 'no-such-file']) {
      const refused = await stand.request('GET', `/api/files/${id}/meta`);

      assert.equal(refused.status, 404, refused.text);
      assert.equal(refused.json<ErrorBody>().error.code, 'not_found');
      assert.equal(refused.headers['cache-control'], 'no-store');
    }

    const signedOut = await stand.request('GET', `/api/files/${own.id}/meta`, { cookie: '' });

    assert.equal(signedOut.status, 401);
  });

  // A store that fails to answer the lookup (the connection lost, the
  // pool's timeout) is not a missing file: the 404 is the lookup's own
  // refusal, the failure is the 500 the client may retry — for the facts
  // and for the bytes alike, and never stored.
  test('a stored file whose row cannot be read is a 500, not a 404', async () => {
    const { ingestFile } = await import('../files/index.ts');
    const file = await ingestFile({ body: Buffer.from('held'), contentType: 'text/plain', sizeBytes: 4, originalFilename: 'held.txt', userId: stand.userId });

    await withFileLookupFailure(async () => {
      for (const url of [`/api/files/${file.id}/meta`, `/api/files/${file.id}`]) {
        const reply = await stand.request('GET', url);

        assert.equal(reply.status, 500, `${url}: ${reply.text}`);
        assert.equal(reply.json<ErrorBody>().error.code, 'internal_error');
        assert.equal(reply.headers['cache-control'], 'no-store');
      }
    });

    // The store answering again, the same request is the file.
    const meta = await stand.request('GET', `/api/files/${file.id}/meta`);

    assert.equal(meta.status, 200, meta.text);
    assert.equal(meta.json<FileMetaResponse>().file.name, 'held.txt');
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

// PUT /files/<rel>: the editor's write — Markdown only, an existing file
// only, the whole content in one step, under the ETag the GET answered.
describe('editing a Markdown file over the api', () => {
  const dir = 'edit-probe';
  const put = (rel: string, text: string, headers: Record<string, string> = {}) =>
    stand.request('PUT', `/files/${rel}`, { text, headers: { 'content-type': 'text/markdown; charset=utf-8', ...headers } });

  before(async () => {
    await fs.mkdir(path.join(filesDir, dir, 'sub'), { recursive: true });
    await fs.writeFile(path.join(filesDir, dir, 'notes.md'), '# Notes\n');
    await fs.writeFile(path.join(filesDir, dir, 'data.csv'), 'a,b\n');
  });

  after(() => fs.rm(path.join(filesDir, dir), { recursive: true, force: true }));

  test('the content is replaced in one step and the answer names the new version: the node, the ETag the GET now answers, the listing', async () => {
    const read = await stand.request('GET', `/files/${dir}/notes.md`);

    assert.equal(read.status, 200, read.text);

    const written = await put(`${dir}/notes.md`, '# Notes\n\n- one — «ё»\n', { 'if-match': read.headers.etag as string });

    assert.equal(written.status, 200, written.text);
    assert.equal(written.headers['cache-control'], 'no-store');

    const { file, etag } = written.json<WorkspaceWriteResponse>();
    const expected = Buffer.byteLength('# Notes\n\n- one — «ё»\n');

    assert.equal(written.headers.etag, etag);
    assert.notEqual(etag, read.headers.etag);
    assert.deepEqual({ ...file, modifiedAt: typeof file.modifiedAt }, { path: `${dir}/notes.md`, sizeBytes: expected, modifiedAt: 'string', title: null, description: null, mediaType: 'text/markdown' });
    assert.equal(await fs.readFile(path.join(filesDir, dir, 'notes.md'), 'utf8'), '# Notes\n\n- one — «ё»\n');

    const again = await stand.request('GET', `/files/${dir}/notes.md`, { headers: { 'if-none-match': etag } });

    assert.equal(again.status, 304);

    const node = (await stand.request('GET', `/api/workspace/node?path=${dir}`)).json<WorkspaceNodeResponse>();

    assert.equal(node.kind, 'dir');
    if (node.kind !== 'dir') return;
    assert.deepEqual(node.files.find(entry => entry.path === `${dir}/notes.md`), file);
    // No temp file of the write is left beside it.
    assert.deepEqual((await fs.readdir(path.join(filesDir, dir))).sort(), ['data.csv', 'notes.md', 'sub']);
  });

  test('a stale If-Match is refused and the file stays; without If-Match the content is replaced whatever is there', async () => {
    const read = await stand.request('GET', `/files/${dir}/notes.md`);

    await fs.writeFile(path.join(filesDir, dir, 'notes.md'), '# Notes\n\nan agent wrote this\n');

    const stale = await put(`${dir}/notes.md`, '# Mine\n', { 'if-match': read.headers.etag as string });

    assert.equal(stale.status, 412);
    assert.equal(stale.json<ErrorBody>().error.code, 'precondition_failed');
    assert.equal(await fs.readFile(path.join(filesDir, dir, 'notes.md'), 'utf8'), '# Notes\n\nan agent wrote this\n');

    const forced = await put(`${dir}/notes.md`, '# Mine\n');

    assert.equal(forced.status, 200, forced.text);
    assert.equal(await fs.readFile(path.join(filesDir, dir, 'notes.md'), 'utf8'), '# Mine\n');
  });

  test('only an existing Markdown file: another kind, a folder, a missing path and a path outside the area are refused, and nothing is created', async () => {
    const csv = await put(`${dir}/data.csv`, 'x,y\n');

    assert.equal(csv.status, 400);
    assert.equal(csv.json<ErrorBody>().error.code, 'not_editable');
    assert.equal(await fs.readFile(path.join(filesDir, dir, 'data.csv'), 'utf8'), 'a,b\n');

    const folder = await put(`${dir}/sub`, '# x\n');

    assert.equal(folder.status, 400);

    const missing = await put(`${dir}/sub/new.md`, '# New\n');

    assert.equal(missing.status, 404);
    assert.equal(missing.json<ErrorBody>().error.code, 'not_found');
    assert.deepEqual(await fs.readdir(path.join(filesDir, dir, 'sub')), []);

    const outside = await put(`${dir}/../escape.md`, '# x\n');

    assert.equal(outside.status, 400);
    assert.equal(await fs.stat(path.join(filesDir, 'escape.md')).catch(() => null), null);

    const bare = await stand.request('PUT', '/files', { text: '# x\n' });

    assert.equal(bare.status, 404);
  });

  test('a body over 2 MiB is refused — declared or counted — and the file stays', async () => {
    const big = 'x'.repeat(2 * 1024 * 1024 + 1);
    const declared = await put(`${dir}/notes.md`, big);

    assert.equal(declared.status, 413);
    assert.equal(declared.json<ErrorBody>().error.code, 'too_large');

    // Chunked, no Content-Length: the limit is counted as the body flows,
    // and the body is read to its end — the client gets the answer, not a
    // reset.
    const counted = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: stand.port, path: `/files/${dir}/notes.md`, method: 'PUT', headers: { host: STAND_HOST, 'x-forwarded-proto': 'https', cookie: stand.cookie, 'content-type': 'text/markdown' } },
        res => {
          const chunks: Buffer[] = [];

          res.on('data', chunk => chunks.push(chunk as Buffer));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
          res.on('error', reject);
        },
      );

      req.on('error', reject);
      req.write(big.slice(0, 1024 * 1024));
      req.end(big.slice(1024 * 1024));
    });

    assert.equal(counted.status, 413, counted.body);
    assert.equal(await fs.readFile(path.join(filesDir, dir, 'notes.md'), 'utf8'), '# Mine\n');
  });

  test('the write is a mutation under the session: signed out it is a 401, cross-site a 403', async () => {
    const signedOut = await stand.request('PUT', `/files/${dir}/notes.md`, { text: '# x\n', cookie: '' });

    assert.equal(signedOut.status, 401);

    const crossSite = await put(`${dir}/notes.md`, '# x\n', { 'sec-fetch-site': 'cross-site', origin: `https://${STAND_HOST}` });

    assert.equal(crossSite.status, 403);
    assert.equal(crossSite.json<ErrorBody>().error.code, 'cross_site');
    assert.equal(await fs.readFile(path.join(filesDir, dir, 'notes.md'), 'utf8'), '# Mine\n');
  });

  test('a symbolic link is not a file of the area: through a link to a folder outside or to a file, the write is refused and nothing changes', async () => {
    // Outside the area, inside the stand's directory (cleaned with it).
    const outside = path.join(filesDir, '..', 'outside-the-area');
    const inside = path.join(filesDir, dir, 'notes.md');
    const kept = await fs.readFile(inside, 'utf8');

    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, 'notes.md'), '# Outside\n');
    await fs.symlink(outside, path.join(filesDir, dir, 'link'));
    await fs.symlink(inside, path.join(filesDir, dir, 'alias.md'));

    try {
      const throughFolder = await put(`${dir}/link/notes.md`, '# Taken over\n');

      assert.equal(throughFolder.status, 404);
      assert.equal(throughFolder.json<ErrorBody>().error.code, 'not_found');
      assert.equal(await fs.readFile(path.join(outside, 'notes.md'), 'utf8'), '# Outside\n');

      const throughFile = await put(`${dir}/alias.md`, '# Taken over\n');

      assert.equal(throughFile.status, 404);
      assert.equal(await fs.readFile(inside, 'utf8'), kept);
      assert.ok((await fs.lstat(path.join(filesDir, dir, 'alias.md'))).isSymbolicLink());
      assert.deepEqual((await fs.readdir(outside)).sort(), ['notes.md']);
    } finally {
      await fs.rm(path.join(filesDir, dir, 'link'), { force: true });
      await fs.rm(path.join(filesDir, dir, 'alias.md'), { force: true });
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  test('a file whose name is near the limit of a name is still written: the temp file has its own short name', async () => {
    const name = `${'a'.repeat(237)}.md`;

    assert.equal(Buffer.byteLength(name), 240);
    await fs.writeFile(path.join(filesDir, dir, name), '# Long\n');

    try {
      const written = await put(`${dir}/${name}`, '# Long, edited\n');

      assert.equal(written.status, 200, written.text);
      assert.equal(await fs.readFile(path.join(filesDir, dir, name), 'utf8'), '# Long, edited\n');
      assert.deepEqual((await fs.readdir(path.join(filesDir, dir))).filter(entry => entry.startsWith('.')), []);
    } finally {
      await fs.rm(path.join(filesDir, dir, name), { force: true });
    }
  });

  test('two writes under one ETag at once: one succeeds, the other is refused — the look and the replacement of one write are one step against the other', { timeout: 30_000 }, async () => {
    const rel = `${dir}/notes.md`;
    const read = await stand.request('GET', `/files/${rel}`);
    const etag = read.headers.etag as string;
    const original = fs.rename;
    let held = false;
    // The first rename is held while the second request arrives: without
    // the lock both looks would pass and both writes would succeed.
    const rename = mock.method(fs, 'rename', async (from: string, to: string) => {
      if (!held) {
        held = true;
        await new Promise(resolve => setTimeout(resolve, 200));
      }

      return original.call(fs, from, to);
    });

    try {
      const [a, b] = await Promise.all([
        put(rel, '# A\n', { 'if-match': etag }),
        new Promise(resolve => setTimeout(resolve, 30)).then(() => put(rel, '# B\n', { 'if-match': etag })),
      ]);

      assert.deepEqual([a.status, b.status].sort(), [200, 412], `${a.text} / ${b.text}`);

      const winner = a.status === 200 ? a : b;

      assert.equal(await fs.readFile(path.join(filesDir, rel), 'utf8'), winner === a ? '# A\n' : '# B\n');
      assert.equal((await stand.request('GET', `/files/${rel}`, { headers: { 'if-none-match': winner.headers.etag as string } })).status, 304);
    } finally {
      rename.mock.restore();
    }
  });

  test('the ETag of the answer names the saved bytes: a replacement by another writer right after the rename lends neither its node nor its tag, and the next save under the answered tag is refused', async () => {
    const rel = `${dir}/notes.md`;
    const abs = path.join(filesDir, rel);
    const original = fs.rename;
    let replaced = false;
    const rename = mock.method(fs, 'rename', async (from: string, to: string) => {
      await original.call(fs, from, to);

      // An agent's replacement in the same instant: another inode under
      // the name, before the route answers.
      if (!replaced && to === abs) {
        replaced = true;
        const theirs = path.join(filesDir, dir, 'theirs.tmp');

        await fs.writeFile(theirs, '# Theirs, right after\n');
        await original.call(fs, theirs, abs);
      }
    });

    try {
      const written = await put(rel, '# Ours\n');

      assert.equal(written.status, 200, written.text);

      const { file, etag } = written.json<WorkspaceWriteResponse>();

      assert.equal(file.sizeBytes, Buffer.byteLength('# Ours\n'));
      assert.equal(written.headers.etag, etag);

      const revalidated = await stand.request('GET', `/files/${rel}`, { headers: { 'if-none-match': etag } });

      assert.equal(revalidated.status, 200);
      assert.notEqual(revalidated.headers.etag, etag);

      const next = await put(rel, '# Ours again\n', { 'if-match': etag });

      assert.equal(next.status, 412);
      assert.equal(await fs.readFile(abs, 'utf8'), '# Theirs, right after\n');
    } finally {
      rename.mock.restore();
    }
  });
});

describe('settings over the api', () => {
  test('PATCH /settings stores the names and /me reads them back', async () => {
    const reply = await stand.request('PATCH', '/api/settings', { body: { workspaceName: '  Home  ', operatorName: 'Vladimir' } });

    assert.equal(reply.status, 200, reply.text);
    assert.deepEqual(reply.json<SettingsResponse>().settings, { workspaceName: 'Home', operatorName: 'Vladimir' });

    const me = await stand.request('GET', '/api/me');

    assert.deepEqual(me.json<MeResponse>(), { userId: stand.userId, workspaceName: 'Home', operatorName: 'Vladimir', mainThreadId: stand.mainThreadId });

    const cleared = await stand.request('PATCH', '/api/settings', { body: { operatorName: '   ' } });

    assert.deepEqual(cleared.json<SettingsResponse>().settings, { workspaceName: 'Home', operatorName: null });

    const user = await prisma.user.findUniqueOrThrow({ where: { id: stand.userId } });

    assert.deepEqual({ workspaceName: user.workspaceName, operatorName: user.operatorName }, { workspaceName: 'Home', operatorName: null });

    // Each change journals settings.updated by the operator with the names
    // the call answered — what every other tab folds into its `me` — and
    // the answer names its event's seq, the position the saving tab holds
    // the names at.
    const events = await settingsEvents();

    assert.deepEqual(
      events.map(({ seq: _seq, ...rest }) => rest),
      [
        { actor: 'user', threadId: null, userId: stand.userId, payload: { workspaceName: 'Home', operatorName: 'Vladimir' } },
        { actor: 'user', threadId: null, userId: stand.userId, payload: { workspaceName: 'Home', operatorName: null } },
      ],
    );
    assert.deepEqual([reply.json<SettingsResponse>().seq, cleared.json<SettingsResponse>().seq], [events[0]!.seq, events[1]!.seq]);
  });

  test('an empty patch answers the names and journals nothing', async () => {
    const reply = await stand.request('PATCH', '/api/settings', { body: {} });

    assert.equal(reply.status, 200, reply.text);
    assert.deepEqual(reply.json<SettingsResponse>(), { settings: { workspaceName: 'Home', operatorName: null }, seq: null });
    assert.equal((await settingsEvents()).length, 2);
  });

  test('GET /settings answers the facts of this browser, the schedule’s time zone and the Telegram binding', async () => {
    const unbound = await stand.request('GET', '/api/settings');

    assert.equal(unbound.status, 200, unbound.text);

    const facts = unbound.json<SettingsFactsResponse>();

    // The stand strips the channel's variables: Telegram is off, no group
    // is bound; the time zone is the configuration's default; the session
    // was born from a console code and the stand's client sends no
    // User-Agent.
    assert.deepEqual(facts.telegram, { enabled: false, botUsername: null, group: null });
    assert.equal(facts.scheduleTimezone, 'Asia/Jerusalem');
    assert.ok(facts.session.createdAt instanceof Date);
    assert.deepEqual({ userAgent: facts.session.userAgent, loginSource: facts.session.loginSource }, { userAgent: '', loginSource: 'console' });

    const row = await prisma.session.findFirstOrThrow({ where: { userId: stand.userId } });

    assert.deepEqual({ createdAt: row.createdAt, loginSource: row.loginSource }, { createdAt: facts.session.createdAt, loginSource: 'console' });

    // A bound group: its id and the moment the binding was written; the
    // title needs the Bot API, which the stand has no token for.
    const linkedAt = new Date('2026-08-06T22:44:25.685Z');

    await prisma.telegramGroup.create({ data: { chatId: -1003986621992n, userId: stand.userId, status: 'active', updatedAt: linkedAt } });

    try {
      const bound = await stand.request('GET', '/api/settings');

      assert.equal(bound.status, 200, bound.text);
      assert.deepEqual(bound.json<SettingsFactsResponse>().telegram, { enabled: false, botUsername: null, group: { chatId: -1003986621992n, title: null, linkedAt } });
    } finally {
      await prisma.telegramGroup.deleteMany({ where: { userId: stand.userId } });
    }
  });

  test('GET /settings answers the session behind the cookie alone, the fields the contract names, and this workspace’s group alone', async () => {
    const { createAuthCode } = await import('./auth-codes.ts');

    // No cookie: refused before any fact is read.
    const anonymous = await stand.request('GET', '/api/settings', { cookie: null });

    assert.equal(anonymous.status, 401);

    // A second browser of the same user, signed in from a code of the
    // Telegram command with its own User-Agent: each cookie reads its own
    // row — the phone's facts are the phone's, the stand's stay the stand's.
    const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_7_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/154.0.8037.55 Mobile/15E148 Safari/604.1';
    const signedIn = await stand.request('POST', '/api/auth', { body: { code: createAuthCode(stand.userId, 'telegram') }, cookie: null, headers: { 'user-agent': ua } });

    assert.equal(signedIn.status, 200, signedIn.text);

    const phone = sessionCookie(signedIn.headers['set-cookie'] ?? []);
    const phoneRow = await prisma.session.findFirstOrThrow({ where: { userId: stand.userId, userAgent: ua } });

    try {
      const phoneFacts = (await stand.request('GET', '/api/settings', { cookie: phone })).json<SettingsFactsResponse>();
      const ownFacts = (await stand.request('GET', '/api/settings')).json<SettingsFactsResponse>();

      assert.deepEqual(phoneFacts.session, { createdAt: phoneRow.createdAt, userAgent: ua, loginSource: 'telegram' });
      assert.deepEqual({ userAgent: ownFacts.session.userAgent, loginSource: ownFacts.session.loginSource }, { userAgent: '', loginSource: 'console' });
      assert.notEqual(ownFacts.session.createdAt.getTime(), phoneRow.createdAt.getTime());

      // Exactly the contract's fields: nothing of the row (id, token hash,
      // lastUsed) rides along.
      assert.deepEqual(Object.keys(ownFacts).sort(), ['scheduleTimezone', 'session', 'telegram']);
      assert.deepEqual(Object.keys(ownFacts.session).sort(), ['createdAt', 'loginSource', 'userAgent']);
      assert.deepEqual(Object.keys(ownFacts.telegram).sort(), ['botUsername', 'enabled', 'group']);

      // A session born before the column, and one with a value the
      // contract does not name: both read as unknown.
      await prisma.session.update({ where: { id: phoneRow.id }, data: { loginSource: null } });
      assert.equal((await stand.request('GET', '/api/settings', { cookie: phone })).json<SettingsFactsResponse>().session.loginSource, null);
      await prisma.session.update({ where: { id: phoneRow.id }, data: { loginSource: 'carrier-pigeon' } });
      assert.equal((await stand.request('GET', '/api/settings', { cookie: phone })).json<SettingsFactsResponse>().session.loginSource, null);
    } finally {
      await prisma.session.delete({ where: { id: phoneRow.id } });
    }

    // Another workspace's bound group is not this one's.
    const other = await prisma.user.create({ data: {} });

    await prisma.telegramGroup.create({ data: { chatId: -1001234567890n, userId: other.id, status: 'active' } });

    try {
      assert.equal((await stand.request('GET', '/api/settings')).json<SettingsFactsResponse>().telegram.group, null);
    } finally {
      await prisma.telegramGroup.deleteMany({ where: { userId: other.id } });
      await prisma.user.delete({ where: { id: other.id } });
    }
  });

  test('a field of another type is refused and nothing is written', async () => {
    const reply = await stand.request('PATCH', '/api/settings', { body: { workspaceName: 5 } });

    assert.equal(reply.status, 400);
    assert.match(reply.json<ErrorBody>().error.message, /workspaceName must be a string/);
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: stand.userId } })).workspaceName, 'Home');
    assert.equal((await settingsEvents()).length, 2);
  });
});

async function settingsEvents(): Promise<{ seq: bigint; actor: string; threadId: string | null; userId: string | null; payload: unknown }[]> {
  const rows = await prisma.event.findMany({ where: { type: 'settings.updated' }, orderBy: { seq: 'asc' } });

  return rows.map(row => ({ seq: row.seq, actor: row.actor, threadId: row.threadId, userId: row.userId, payload: row.payload }));
}

describe('the plan limits over the api', () => {
  test('GET /limits answers the process’s measurement: none without a Claude session, the view a live session’s control gives, the kept view once it is gone', async () => {
    const { planLimits } = await import('../harness/claude-sdk/plan-limits.ts');

    const none = await stand.request('GET', '/api/limits');

    assert.equal(none.status, 200, none.text);
    assert.deepEqual(none.json<LimitsResponse>(), { limits: null, liveSessions: 0, lastSessionAt: null });

    // A live session's control, as sdk-session.ts registers it.
    const unregister = planLimits.registerProvider('thread-limits', async () => ({
      session: { total_cost_usd: 0, total_api_duration_ms: 0, total_duration_ms: 0, total_lines_added: 0, total_lines_removed: 0, model_usage: {} },
      subscription_type: 'max',
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 47, resets_at: '2026-10-10T18:00:00Z' },
        seven_day: { utilization: 81, resets_at: '2026-10-13T10:00:00Z' },
        extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null },
      },
      behaviors: null,
    }));

    try {
      const live = await stand.request('GET', '/api/limits');

      assert.equal(live.status, 200, live.text);

      const body = live.json<LimitsResponse>();

      assert.equal(body.liveSessions, 1);
      assert.ok(body.limits && body.limits.measuredAt instanceof Date);
      assert.deepEqual(
        { ...body.limits, measuredAt: undefined },
        {
          measuredAt: undefined,
          subscriptionType: 'max',
          available: true,
          windows: [
            { kind: 'five_hour', model: null, utilization: 47, resetsAt: new Date('2026-10-10T18:00:00Z'), status: null },
            { kind: 'seven_day', model: null, utilization: 81, resetsAt: new Date('2026-10-13T10:00:00Z'), status: null },
          ],
          overage: { enabled: false, inUse: false, usedCredits: null, monthlyLimit: null, utilization: null, currency: null },
        },
      );
    } finally {
      unregister();
    }

    planLimits.sessionEnded('thread-limits');

    const after = (await stand.request('GET', '/api/limits')).json<LimitsResponse>();

    assert.equal(after.liveSessions, 0);
    assert.equal(after.limits?.subscriptionType, 'max');
    assert.ok(after.lastSessionAt instanceof Date);

    // A reading, not a mutation: the session is still required.
    assert.equal((await stand.request('GET', '/api/limits', { cookie: null })).status, 401);
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
