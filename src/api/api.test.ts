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

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { STAND_HOST, startStand } from '../test-support/stand.ts';
import type { Reply, Stand } from '../test-support/stand.ts';
import type { CreateProjectResponse, ProjectResponse, SettingsResponse, MeResponse } from './contract.ts';

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
    let reply: Promise<Reply> | null = null;

    try {
      await rowHeld;
      reply = stand.request('POST', '/api/projects', { body: { title: 'Loser', slug: 'held', description: 'The body that loses.' }, signal: aborter.signal });
      await Promise.race([
        waitForLockWaiter(),
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
      abandon(new Error('the scenario is over'));
      aborter.abort();
      await Promise.allSettled([held, reply]);
    }
  });
});

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
    assert.match(first.headers.etag ?? '', /^W\/"[0-9a-f]+-[0-9a-f]+"$/);

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
});

// A promise that rejects when the given one does and never resolves — to
// race a wait against the failure of what it depends on.
function failureOf(promise: Promise<unknown>): Promise<never> {
  return promise.then(() => new Promise<never>(() => {}));
}

// Until a session of the stand's database waits for a lock — the creation's
// insert blocked on the unique index behind the row the test holds.
async function waitForLockWaiter(): Promise<void> {
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    const [row] = await prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;

    if (row && row.n > 0) {
      return;
    }

    await new Promise(resolve => setTimeout(resolve, 20));
  }

  assert.fail('the creation never waited for the row');
}

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
