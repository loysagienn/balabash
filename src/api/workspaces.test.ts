// Several workspaces in one browser over the stand (src/test-support/stand.ts):
// one session cookie, the workspaces it is signed in to; a code exchanged by a
// browser already signed in adds its workspace to the same session; each
// request acts in the workspace it names (the X-Balabash-Workspace header or
// ?ws=), else in the session's primary one; naming a workspace this browser is
// not signed in to is a 401 of its own code (except /me, which answers the
// primary one); signing out leaves the others signed in, hands the primary role
// on, and the last one ends the session.
//
// Run: npm test  (node:test, native type stripping — no build needed).

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { STAND_HOST, sessionCookie, startStand } from '../test-support/stand.ts';
import type { Stand } from '../test-support/stand.ts';
import type { CreateProjectResponse, LogoutResponse, MeResponse, WorkspacesResponse } from './contract.ts';

type ErrorBody = { error: { code: string; message: string } };

const HEADER = 'x-balabash-workspace';

let stand: Stand;
let prisma: typeof import('../db/client.ts')['prisma'];
let createAuthCode: typeof import('./auth-codes.ts')['createAuthCode'];

before(async () => {
  stand = await startStand();
  ({ prisma } = await import('../db/client.ts'));
  ({ createAuthCode } = await import('./auth-codes.ts'));
});

after(() => stand.stop());

async function newWorkspace(workspaceName: string): Promise<string> {
  return (await prisma.user.create({ data: { workspaceName } })).id;
}

// A browser of its own: a fresh session signed in to `userId`.
async function newBrowser(userId: string): Promise<string> {
  const reply = await stand.request('POST', '/api/auth', { body: { code: createAuthCode(userId, 'console') }, cookie: null });

  assert.equal(reply.status, 200, reply.text);

  return sessionCookie(reply.headers['set-cookie'] ?? []);
}

async function signIn(cookie: string, userId: string): Promise<MeResponse> {
  const reply = await stand.request('POST', '/api/auth', { body: { code: createAuthCode(userId, 'telegram') }, cookie });

  assert.equal(reply.status, 200, reply.text);

  return reply.json<MeResponse>();
}

// The session row behind a cookie (the token's hash, as session.ts keeps it).
async function sessionOf(cookie: string) {
  const { config } = await import('../config/index.ts');
  const token = cookie.slice(cookie.indexOf('=') + 1);
  const tokenHash = crypto.createHash('sha256').update(token + config.sessionPepper).digest('hex');

  return prisma.session.findUniqueOrThrow({ where: { tokenHash } });
}

describe('several workspaces in one browser', () => {
  let family: string;
  let stranger: string;

  before(async () => {
    await prisma.user.update({ where: { id: stand.userId }, data: { workspaceName: 'Personal', operatorName: 'Vladimir' } });
    family = await newWorkspace('Family');
    stranger = await newWorkspace('Stranger');
  });

  test('a code exchanged by a signed-in browser adds its workspace to the same session', async () => {
    const before = await prisma.session.count();
    const me = await signIn(stand.cookie, family);

    assert.equal(me.userId, family);
    assert.equal(me.workspaceName, 'Family');
    assert.equal(await prisma.session.count(), before, 'no second session');

    const session = await sessionOf(stand.cookie);

    assert.equal(session.userId, stand.userId, 'the first workspace stays the primary one');
    assert.deepEqual(
      (await prisma.sessionWorkspace.findMany({ where: { sessionId: session.id }, orderBy: { createdAt: 'asc' } })).map(row => [row.userId, row.loginSource]),
      [
        [stand.userId, 'console'],
        [family, 'telegram'],
      ],
    );

    // Signing in again to a workspace already there changes nothing.
    await signIn(stand.cookie, family);
    assert.equal(await prisma.sessionWorkspace.count({ where: { sessionId: session.id } }), 2);
  });

  test('GET /workspaces lists them in order with their names; the request’s workspace is current', async () => {
    const plain = (await stand.request('GET', '/api/workspaces')).json<WorkspacesResponse>();

    assert.equal(plain.current, stand.userId);
    assert.deepEqual(
      plain.workspaces.map(w => ({ userId: w.userId, workspaceName: w.workspaceName, operatorName: w.operatorName, loginSource: w.loginSource, at: w.signedInAt instanceof Date })),
      [
        { userId: stand.userId, workspaceName: 'Personal', operatorName: 'Vladimir', loginSource: 'console', at: true },
        { userId: family, workspaceName: 'Family', operatorName: null, loginSource: 'telegram', at: true },
      ],
    );

    const named = (await stand.request('GET', '/api/workspaces', { headers: { [HEADER]: family } })).json<WorkspacesResponse>();

    assert.equal(named.current, family);
  });

  test('a request acts in the workspace it names — by the header or by ?ws=', async () => {
    assert.equal((await stand.request('GET', '/api/me')).json<MeResponse>().userId, stand.userId);
    assert.equal((await stand.request('GET', '/api/me', { headers: { [HEADER]: family } })).json<MeResponse>().userId, family);
    assert.equal((await stand.request('GET', `/api/me?ws=${family}`)).json<MeResponse>().userId, family);

    const created = await stand.request('POST', '/api/projects', { body: { title: 'Garden', slug: 'garden', description: 'Family garden.' }, headers: { [HEADER]: family } });

    assert.equal(created.status, 200, created.text);

    const row = await prisma.project.findUniqueOrThrow({ where: { id: created.json<CreateProjectResponse>().project.id } });

    assert.equal(row.userId, family);
  });

  test('a workspace this browser is not signed in to is refused with its own code; /me answers the primary one instead', async () => {
    const threads = await stand.request('GET', '/api/threads', { headers: { [HEADER]: stranger } });

    assert.equal(threads.status, 401);
    assert.equal(threads.json<ErrorBody>().error.code, 'workspace_signed_out');

    const byQuery = await stand.request('GET', `/api/workspaces?ws=${stranger}`);

    assert.equal(byQuery.status, 401);
    assert.equal(byQuery.json<ErrorBody>().error.code, 'workspace_signed_out');

    const me = await stand.request('GET', '/api/me', { headers: { [HEADER]: stranger } });

    assert.equal(me.status, 200);
    assert.equal(me.json<MeResponse>().userId, stand.userId);

    // No cookie at all is still the plain 401.
    const anonymous = await stand.request('GET', '/api/me', { cookie: null, headers: { [HEADER]: family } });

    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.json<ErrorBody>().error.code, 'unauthorized');
  });

  test('signing out of one workspace leaves the others signed in', async () => {
    const browser = await newBrowser(stand.userId);

    await signIn(browser, family);

    const out = await stand.request('POST', '/api/logout', { cookie: browser, headers: { [HEADER]: family } });

    assert.equal(out.status, 200, out.text);
    assert.deepEqual(out.json<LogoutResponse>(), { ok: true, signedIn: [stand.userId] });

    const gone = await stand.request('GET', '/api/threads', { cookie: browser, headers: { [HEADER]: family } });

    assert.equal(gone.status, 401);
    assert.equal(gone.json<ErrorBody>().error.code, 'workspace_signed_out');
    assert.equal((await stand.request('GET', '/api/me', { cookie: browser })).json<MeResponse>().userId, stand.userId);

    // The stand's own browser is another session: Family stays signed in there.
    assert.equal((await stand.request('GET', '/api/me', { headers: { [HEADER]: family } })).json<MeResponse>().userId, family);
  });

  test('signing out of the primary workspace hands the role on; the last one ends the session', async () => {
    const browser = await newBrowser(stand.userId);

    await signIn(browser, family);

    const session = await sessionOf(browser);
    const first = await stand.request('POST', '/api/logout', { cookie: browser });

    assert.deepEqual(first.json<LogoutResponse>(), { ok: true, signedIn: [family] });
    assert.equal((await prisma.session.findUniqueOrThrow({ where: { id: session.id } })).userId, family);
    assert.equal((await stand.request('GET', '/api/me', { cookie: browser })).json<MeResponse>().userId, family, 'a request naming nothing acts in the new primary');

    const last = await stand.request('POST', '/api/logout', { cookie: browser });

    assert.deepEqual(last.json<LogoutResponse>(), { ok: true, signedIn: [] });
    assert.ok((last.headers['set-cookie'] ?? []).some(line => /^session_id=;/.test(line)), 'the cookie is cleared');
    assert.equal(await prisma.session.count({ where: { id: session.id } }), 0);
    assert.equal(await prisma.sessionWorkspace.count({ where: { sessionId: session.id } }), 0);
    assert.equal((await stand.request('GET', '/api/me', { cookie: browser })).status, 401);
  });

  test('the one-time link of a secret request names its workspace', async () => {
    const { secretRequestUrl } = await import('../capabilities/secret-requests.ts');

    assert.equal(secretRequestUrl('req-1', family), `https://${STAND_HOST}/secrets/req-1?ws=${family}`);
  });
});
