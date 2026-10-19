// The user behind a web session over the stand (src/test-support/stand.ts):
// a code is issued to a user, the session born from it is theirs; a
// session without a user (born before users existed) is no session; a
// browser signed in as one user that exchanges another user's code becomes
// that user's; what the session writes carries the user's identity.
//
// Run: npm test  (node:test, native type stripping — no build needed).

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { sessionCookie, startStand } from '../test-support/stand.ts';
import type { Stand } from '../test-support/stand.ts';
import type { MeResponse, PostThreadMessageResponse, ThreadCommandResponse } from './contract.ts';

type ErrorBody = { error: { code: string; message: string } };

let stand: Stand;
let prisma: typeof import('../db/client.ts')['prisma'];
let createAuthCode: typeof import('./auth-codes.ts')['createAuthCode'];
let consumeAuthCode: typeof import('./auth-codes.ts')['consumeAuthCode'];

before(async () => {
  stand = await startStand();
  ({ prisma } = await import('../db/client.ts'));
  ({ createAuthCode, consumeAuthCode } = await import('./auth-codes.ts'));
});

after(() => stand.stop());

async function sessionOf(cookie: string) {
  const { config } = await import('../config/index.ts');
  const token = cookie.slice(cookie.indexOf('=') + 1);
  const tokenHash = crypto.createHash('sha256').update(token + config.sessionPepper).digest('hex');

  return prisma.session.findUnique({ where: { tokenHash } });
}

async function newUser(displayName: string): Promise<string> {
  return (await prisma.user.create({ data: { displayName } })).id;
}

describe('one-time codes', () => {
  test('a code is issued to a user for a workspace; a new code of the same user replaces theirs, another user’s stays', () => {
    const mine = createAuthCode({ workspaceId: 'w', userId: 'me' }, 'telegram');
    const hers = createAuthCode({ workspaceId: 'w', userId: 'her' }, 'telegram');
    const mineAgain = createAuthCode({ workspaceId: 'w', userId: 'me' }, 'console');

    assert.equal(consumeAuthCode(mine), null);
    assert.deepEqual(consumeAuthCode(hers), { workspaceId: 'w', userId: 'her', source: 'telegram' });
    assert.deepEqual(consumeAuthCode(mineAgain.toLowerCase()), { workspaceId: 'w', userId: 'me', source: 'console' });
    assert.equal(consumeAuthCode(mineAgain), null, 'one-time');
  });
});

describe('the user of a web session', () => {
  test('the session born of a code is the code’s user; /me words them', async () => {
    const session = await sessionOf(stand.cookie);

    assert.equal(session?.userId, stand.userId);
    assert.deepEqual((await stand.request('GET', '/api/me')).json<MeResponse>().user, { userId: stand.userId, displayName: 'Operator' });
  });

  test('a session without a user is no session: 401, the row stays for its sweep; the browser signs in anew', async () => {
    const code = createAuthCode({ workspaceId: stand.workspaceId, userId: stand.userId }, 'telegram');
    const signedIn = await stand.request('POST', '/api/auth', { body: { code }, cookie: null });

    assert.equal(signedIn.status, 200, signedIn.text);

    const legacy = sessionCookie(signedIn.headers['set-cookie'] ?? []);
    const row = await sessionOf(legacy);

    assert.ok(row);
    await prisma.session.update({ where: { id: row.id }, data: { userId: null } });

    const refused = await stand.request('GET', '/api/me', { cookie: legacy });

    assert.equal(refused.status, 401);
    assert.equal(refused.json<ErrorBody>().error.code, 'unauthorized');
    assert.ok(await prisma.session.findUnique({ where: { id: row.id } }), 'the row is not deleted');

    const again = await stand.request('POST', '/api/auth', { body: { code: createAuthCode({ workspaceId: stand.workspaceId, userId: stand.userId }, 'telegram') }, cookie: legacy });

    assert.equal(again.status, 200, again.text);

    const fresh = sessionCookie(again.headers['set-cookie'] ?? []);

    assert.notEqual(fresh, legacy);
    assert.equal((await sessionOf(fresh))?.userId, stand.userId);
    assert.ok(await prisma.session.findUnique({ where: { id: row.id } }), 'the legacy row is still not ours to delete');
  });

  test('a browser signed in as one user that exchanges another user’s code becomes that user’s: a new session, the old one gone', async () => {
    const ksenia = await newUser('Ksenia');
    const mine = await stand.request('POST', '/api/auth', { body: { code: createAuthCode({ workspaceId: stand.workspaceId, userId: stand.userId }, 'telegram') }, cookie: null });
    const cookie = sessionCookie(mine.headers['set-cookie'] ?? []);
    const mineRow = await sessionOf(cookie);

    assert.ok(mineRow);

    const hers = await stand.request('POST', '/api/auth', { body: { code: createAuthCode({ workspaceId: stand.workspaceId, userId: ksenia }, 'telegram') }, cookie });

    assert.equal(hers.status, 200, hers.text);
    assert.deepEqual(hers.json<MeResponse>().user, { userId: ksenia, displayName: 'Ksenia' });

    const herCookie = sessionCookie(hers.headers['set-cookie'] ?? []);

    assert.notEqual(herCookie, cookie);
    assert.equal((await sessionOf(herCookie))?.userId, ksenia);
    assert.equal(await prisma.session.findUnique({ where: { id: mineRow.id } }), null, 'the other user’s session ended');
    assert.equal(await prisma.sessionWorkspace.count({ where: { sessionId: mineRow.id } }), 0);

    // The same user's code adds to the session as before.
    const other = (await prisma.workspace.create({ data: { workspaceName: 'Other' } })).id;
    const added = await stand.request('POST', '/api/auth', { body: { code: createAuthCode({ workspaceId: other, userId: ksenia }, 'telegram') }, cookie: herCookie });

    assert.equal(added.status, 200, added.text);
    assert.ok((added.headers['set-cookie'] ?? []).every(header => !header.startsWith('session_id=')), 'no new cookie');
    assert.equal(await prisma.sessionWorkspace.count({ where: { sessionId: (await sessionOf(herCookie))!.id } }), 2);
  });

  test('what the session writes carries the user and their name as of now', async () => {
    await stand.request('PATCH', '/api/user', { body: { displayName: 'Vladimir' } });

    try {
      const posted = await stand.request('POST', `/api/threads/${stand.mainThreadId}/messages`, { body: { text: 'hello' } });

      assert.equal(posted.status, 200, posted.text);
      assert.deepEqual(posted.json<PostThreadMessageResponse>().event.payload, { text: 'hello', identity: { userId: stand.userId, displayName: 'Vladimir' }, source: 'web' });

      const { appendEvent } = await import('../core/append.ts');
      const child = crypto.randomUUID();

      await appendEvent({ type: 'thread.started', actor: 'system', workspaceId: stand.workspaceId, threadId: child, targetThreadId: stand.mainThreadId, payload: { agent: 'engineer', title: 'Child' } });

      const interrupted = await stand.request('POST', `/api/threads/${child}/interrupt`);

      assert.equal(interrupted.status, 200, interrupted.text);
      assert.deepEqual(interrupted.json<ThreadCommandResponse>().event.payload, { reason: 'interrupted_by_user', identity: { userId: stand.userId, displayName: 'Vladimir' }, source: 'web' });
    } finally {
      await stand.request('PATCH', '/api/user', { body: { displayName: 'Operator' } });
    }
  });
});
