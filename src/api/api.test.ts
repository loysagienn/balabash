// The /api namespace over the stand (src/test-support/stand.ts): the
// projects endpoints write the row, the folder and the project.* event
// together and answer the console's shapes and refusals; PATCH /settings
// stores the names; a cross-site mutation is refused; a race of two
// creations leaves one row.
//
// Run: npm test  (node:test, native type stripping — no build needed).

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { startStand } from '../test-support/stand.ts';
import type { Stand } from '../test-support/stand.ts';
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

  test('two creations of one slug at once: one row, one event, one conflict', async () => {
    const body = { title: 'Race', slug: 'race', description: 'd' };
    const replies = await Promise.all([
      stand.request('POST', '/api/projects', { body }),
      stand.request('POST', '/api/projects', { body }),
    ]);

    assert.deepEqual(replies.map(reply => reply.status).sort(), [200, 409]);
    assert.equal(await prisma.project.count({ where: { slug: 'race' } }), 1);
    assert.equal((await projectEvents()).filter(event => event.type === 'project.created').length, 2);
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

  test('an unknown endpoint answers JSON 404', async () => {
    const reply = await stand.request('GET', '/api/nothing-here');

    assert.equal(reply.status, 404);
    assert.equal(reply.json<ErrorBody>().error.code, 'not_found');
  });
});
