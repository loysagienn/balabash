// The connections over the stand (src/test-support/stand.ts): a rename
// answers the row and journals connection.renamed to the row's thread, a
// name in use is refused and the row stays; a disconnect answers the row as
// it was, drops it and journals connection.disconnected; a sign-in link for
// an existing account binds the row to the main thread and journals
// connection.pending there, a connected account stays connected; the
// catalog's "Connect" issues a link for a new account — the service's first
// under the default address, a named one under an address derived from the
// name — and refuses a second account without a name, a name in use, a
// service of one account; another workspace's rows and an unknown service
// are not found. The connectable services are registered on the stand
// itself (loadToolServers would connect the installation's real servers).
//
// Run: npm test  (node:test, native type stripping — no build needed).

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startStand } from '../test-support/stand.ts';
import type { Stand } from '../test-support/stand.ts';
import type { ConnectLinkResponse, ConnectionResponse } from './contract.ts';

type ErrorBody = { error: { code: string; message: string } };

let stand: Stand;
let prisma: typeof import('../db/client.ts')['prisma'];

const FOREIGN_USER = randomUUID();
const DOMAIN = 'balabash.test';
const LINK_TTL_MS = 15 * 60 * 1000;

// Ids of the seeded rows.
const ROWS = {
  solo: 'c0000000-0000-4000-8000-000000000001',
  work: 'c0000000-0000-4000-8000-000000000002',
  home: 'c0000000-0000-4000-8000-000000000003',
  foreign: 'c0000000-0000-4000-8000-000000000004',
};

before(async () => {
  stand = await startStand();
  ({ prisma } = await import('../db/client.ts'));

  // The stand clears the inherited environment; the links are built from
  // the domain.
  process.env.DOMAIN = DOMAIN;

  const { registerUserAuthServer } = await import('../capabilities/tool-manager.ts');
  const service = (name: string, identityProbe: boolean) =>
    registerUserAuthServer({
      name,
      origin: 'external',
      url: `https://${name}.example/mcp`,
      description: `${name} service`,
      clientRegistration: 'dynamic',
      scope: null,
      authorizationParams: null,
      identityProbe: identityProbe ? { url: `https://${name}.example/me`, idField: 'id', labelField: 'email' } : null,
      enabledTools: undefined,
      toolOverrides: undefined,
      prefixTools: false,
    });

  // One account at most (no identity probe), several accounts, none yet.
  service('solo', false);
  service('multi', true);
  service('fresh', false);

  const row = (id: string, server: string, accountKey: string, displayName: string, data: Record<string, unknown> = {}) =>
    prisma.connection.create({ data: { id, userId: stand.userId, server, accountKey, displayName, status: 'connected', ...data } });

  await row(ROWS.solo, 'solo', 'default', 'solo', { threadId: stand.mainThreadId, metadata: { scope: 'read write' }, identity: { id: 'u-1', label: 'me@solo.example' }, identityId: 'u-1' });
  await row(ROWS.work, 'multi', 'work', 'Work', { identityId: 'm-1', identity: { id: 'm-1', label: 'work@multi.example' } });
  await row(ROWS.home, 'multi', 'home', 'Home', { status: 'reauthorization_required', identityId: 'm-2' });
  await prisma.connection.create({ data: { id: ROWS.foreign, userId: FOREIGN_USER, server: 'solo', accountKey: 'default', displayName: 'Foreign', status: 'connected' } });
});

after(() => stand.stop());

async function connectionEvents(): Promise<{ type: string; actor: string; targetThreadId: string | null; payload: Record<string, unknown> }[]> {
  const rows = await prisma.event.findMany({ where: { type: { startsWith: 'connection.' } }, orderBy: { seq: 'asc' } });

  return rows.map(event => ({ type: event.type, actor: event.actor, targetThreadId: event.targetThreadId, payload: event.payload as Record<string, unknown> }));
}

describe('renaming an account', () => {
  test('PATCH /connections/:id answers the row with the new name and journals connection.renamed to the row’s thread', async () => {
    const reply = await stand.request('PATCH', `/api/connections/${ROWS.solo}`, { body: { name: '  Main solo  ' } });

    assert.equal(reply.status, 200, reply.text);

    const { connection } = reply.json<ConnectionResponse>();

    assert.equal(connection.id, ROWS.solo);
    assert.equal(connection.displayName, 'Main solo');
    assert.equal(connection.accountKey, 'default');
    assert.equal(connection.status, 'connected');
    assert.equal(connection.identity, 'me@solo.example');
    assert.equal(connection.scope, 'read write');
    assert.ok(connection.updatedAt instanceof Date);

    const events = await connectionEvents();
    const renamed = events.find(event => event.type === 'connection.renamed');

    assert.ok(renamed, 'connection.renamed journaled');
    assert.equal(renamed.actor, 'system');
    assert.equal(renamed.targetThreadId, stand.mainThreadId);
    assert.deepEqual(renamed.payload, { connectionId: ROWS.solo, server: 'solo', account: 'default', name: 'Main solo', previousName: 'solo' });
  });

  test('an empty name, a name of another account of the service and a malformed body are refused; the row stays', async () => {
    const empty = await stand.request('PATCH', `/api/connections/${ROWS.work}`, { body: { name: '   ' } });

    assert.equal(empty.status, 400, empty.text);
    assert.equal(empty.json<ErrorBody>().error.code, 'bad_request');

    const clash = await stand.request('PATCH', `/api/connections/${ROWS.work}`, { body: { name: 'home' } });

    assert.equal(clash.status, 409, clash.text);
    assert.equal(clash.json<ErrorBody>().error.code, 'conflict');
    assert.match(clash.json<ErrorBody>().error.message, /already used by account "home"/);

    const missing = await stand.request('PATCH', `/api/connections/${ROWS.work}`, { body: {} });

    assert.equal(missing.status, 400, missing.text);

    const number = await stand.request('PATCH', `/api/connections/${ROWS.work}`, { body: { name: 5 } });

    assert.equal(number.status, 400, number.text);

    const row = await prisma.connection.findUnique({ where: { id: ROWS.work } });

    assert.equal(row?.displayName, 'Work');
  });

  test('the same name again is not a clash with itself', async () => {
    const reply = await stand.request('PATCH', `/api/connections/${ROWS.work}`, { body: { name: 'work' } });

    assert.equal(reply.status, 200, reply.text);
    assert.equal(reply.json<ConnectionResponse>().connection.displayName, 'work');
  });

  test('another workspace’s row and an unknown id are not found alike', async () => {
    const foreign = await stand.request('PATCH', `/api/connections/${ROWS.foreign}`, { body: { name: 'Mine' } });
    const unknown = await stand.request('PATCH', `/api/connections/${randomUUID()}`, { body: { name: 'Mine' } });

    assert.equal(foreign.status, 404, foreign.text);
    assert.equal(unknown.status, 404, unknown.text);
    assert.equal(foreign.json<ErrorBody>().error.message, unknown.json<ErrorBody>().error.message);

    const row = await prisma.connection.findUnique({ where: { id: ROWS.foreign } });

    assert.equal(row?.displayName, 'Foreign');
  });
});

describe('a sign-in link for an existing account', () => {
  test('POST /connections/:id/reconnect answers the link, binds the row to the main thread and journals connection.pending there; a connected account stays connected', async () => {
    const before = Date.now();
    const reply = await stand.request('POST', `/api/connections/${ROWS.solo}/reconnect`, { body: {} });

    assert.equal(reply.status, 200, reply.text);

    const { url, connection, expiresAt } = reply.json<ConnectLinkResponse>();

    assert.match(url, new RegExp(`^https://${DOMAIN.replace('.', '\\.')}/connect/solo\\?nonce=[A-Za-z0-9_-]{20,}$`));
    assert.equal(connection.id, ROWS.solo);
    assert.equal(connection.status, 'connected');
    assert.equal(connection.threadId, stand.mainThreadId);
    assert.ok(expiresAt instanceof Date);
    assert.ok(expiresAt.getTime() >= before + LINK_TTL_MS - 1_000 && expiresAt.getTime() <= Date.now() + LINK_TTL_MS, 'the link lives its TTL');

    const row = await prisma.connection.findUnique({ where: { id: ROWS.solo } });

    assert.equal(row?.threadId, stand.mainThreadId);
    assert.equal(row?.status, 'connected');
    assert.ok(row?.connectNonce && url.endsWith(row.connectNonce), 'the link carries the row’s nonce');

    const pending = (await connectionEvents()).filter(event => event.type === 'connection.pending');

    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.targetThreadId, stand.mainThreadId);
    assert.equal(pending[0]!.payload.connectionId, ROWS.solo);
    assert.equal(pending[0]!.payload.status, 'connected');
    assert.ok(!JSON.stringify(pending[0]!.payload).includes(row.connectNonce), 'the nonce stays out of the log');
  });

  test('an account that needs sign-in gets its link too and goes pending until the flow completes', async () => {
    const reply = await stand.request('POST', `/api/connections/${ROWS.home}/reconnect`, { body: {} });

    assert.equal(reply.status, 200, reply.text);
    // Only a connected account keeps its status over a new link.
    assert.equal(reply.json<ConnectLinkResponse>().connection.status, 'pending');
  });

  test('another workspace’s row is not found', async () => {
    const reply = await stand.request('POST', `/api/connections/${ROWS.foreign}/reconnect`, { body: {} });

    assert.equal(reply.status, 404, reply.text);
  });
});

describe('connecting a new account from the catalog', () => {
  test('POST /connections without a name issues the service’s first account under the default address', async () => {
    const reply = await stand.request('POST', '/api/connections', { body: { server: 'fresh' } });

    assert.equal(reply.status, 200, reply.text);

    const { url, connection } = reply.json<ConnectLinkResponse>();

    assert.match(url, /\/connect\/fresh\?nonce=/);
    assert.equal(connection.server, 'fresh');
    assert.equal(connection.accountKey, 'default');
    assert.equal(connection.displayName, 'fresh');
    assert.equal(connection.status, 'pending');
    assert.equal(connection.threadId, stand.mainThreadId);
    assert.equal(connection.identity, null);

    const pending = (await connectionEvents()).filter(event => event.type === 'connection.pending' && event.payload.server === 'fresh');

    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.payload.connectionId, connection.id);
    assert.equal(pending[0]!.payload.status, 'pending');
  });

  test('a named account gets an address derived from the name; the name in use and a second nameless account are refused', async () => {
    const named = await stand.request('POST', '/api/connections', { body: { server: 'multi', name: ' Личный ' } });

    assert.equal(named.status, 200, named.text);

    const { connection } = named.json<ConnectLinkResponse>();

    assert.equal(connection.accountKey, 'lichnyi');
    assert.equal(connection.displayName, 'Личный');
    assert.equal(connection.status, 'pending');

    const again = await stand.request('POST', '/api/connections', { body: { server: 'multi', name: 'личный' } });

    assert.equal(again.status, 409, again.text);
    assert.match(again.json<ErrorBody>().error.message, /already used by account "lichnyi"/);

    const nameless = await stand.request('POST', '/api/connections', { body: { server: 'multi' } });

    assert.equal(nameless.status, 409, nameless.text);
    assert.match(nameless.json<ErrorBody>().error.message, /already has an account/);
    assert.equal(await prisma.connection.count({ where: { userId: stand.userId, server: 'multi' } }), 3);
  });

  test('a service of one account refuses a second one; an unknown service and a malformed body are refused', async () => {
    const second = await stand.request('POST', '/api/connections', { body: { server: 'solo', name: 'Another' } });

    assert.equal(second.status, 409, second.text);
    assert.match(second.json<ErrorBody>().error.message, /at most one connected account/);

    const unknown = await stand.request('POST', '/api/connections', { body: { server: 'nope' } });

    assert.equal(unknown.status, 404, unknown.text);

    const noServer = await stand.request('POST', '/api/connections', { body: { name: 'x' } });

    assert.equal(noServer.status, 400, noServer.text);

    const badName = await stand.request('POST', '/api/connections', { body: { server: 'fresh', name: 7 } });

    assert.equal(badName.status, 400, badName.text);
    assert.equal(await prisma.connection.count({ where: { userId: stand.userId, server: 'solo' } }), 1);
  });
});

describe('disconnecting an account', () => {
  test('DELETE /connections/:id answers the row as it was, drops it and journals connection.disconnected; a second delete is not found', async () => {
    const reply = await stand.request('DELETE', `/api/connections/${ROWS.home}`);

    assert.equal(reply.status, 200, reply.text);

    const { connection } = reply.json<ConnectionResponse>();

    assert.equal(connection.id, ROWS.home);
    assert.equal(connection.displayName, 'Home');
    assert.equal(await prisma.connection.findUnique({ where: { id: ROWS.home } }), null);

    const gone = (await connectionEvents()).filter(event => event.type === 'connection.disconnected');

    assert.equal(gone.length, 1);
    assert.equal(gone[0]!.targetThreadId, stand.mainThreadId);
    assert.deepEqual(gone[0]!.payload, { connectionId: ROWS.home, server: 'multi', account: 'home', name: 'Home', reason: 'disconnected' });

    const again = await stand.request('DELETE', `/api/connections/${ROWS.home}`);

    assert.equal(again.status, 404, again.text);
  });

  test('another workspace’s row is not found and stays', async () => {
    const reply = await stand.request('DELETE', `/api/connections/${ROWS.foreign}`);

    assert.equal(reply.status, 404, reply.text);
    assert.ok(await prisma.connection.findUnique({ where: { id: ROWS.foreign } }));
  });

  test('without a session every command is 401', async () => {
    for (const [method, path] of [
      ['PATCH', `/api/connections/${ROWS.solo}`],
      ['DELETE', `/api/connections/${ROWS.solo}`],
      ['POST', `/api/connections/${ROWS.solo}/reconnect`],
      ['POST', '/api/connections'],
    ] as const) {
      const reply = await stand.request(method, path, { body: {}, cookie: '' });

      assert.equal(reply.status, 401, `${method} ${path}: ${reply.text}`);
    }
  });
});
