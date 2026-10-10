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
// are not found. A command names the row the screen showed: an address
// that belongs to another row by the command (the account disconnected
// and connected again under it while the request was on its way — the
// test holds the module's (user, server) lock and swaps the row under it)
// is refused and the newcomer stays untouched; a row gone by then is not
// found and not born again. The rules of "Connect" hold at the write: a
// first account that another writer adds meanwhile makes a nameless
// connect a refusal, not a re-authorization; two named connects on a
// service of one account leave one row. The callback's identity refusal
// (the consent came from a provider account other than the one the row
// is bound to — the exchange and the probe over a mocked fetch) leaves
// the row as before the exchange, the link included: the next click
// restarts the flow. The connectable services are registered on the
// stand itself (loadToolServers would connect the installation's real
// servers).
//
// Run: npm test  (node:test, native type stripping — no build needed).

import { test, describe, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startStand } from '../test-support/stand.ts';
import type { Reply, Stand } from '../test-support/stand.ts';
import type { Prisma } from '../../prisma-generated/client.ts';
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

  // One account at most (no identity probe), several accounts, none yet;
  // two more of one account for the races.
  service('solo', false);
  service('multi', true);
  service('fresh', false);
  service('race', false);
  service('race2', false);

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

// Holds the module's (user, server) lock in a transaction of its own; once
// a request of the test waits on it (the request read its row ahead of the
// lock), changes the registry under the lock and commits — so the command
// runs over a registry that is not the one the request read. Every wait is
// raced against the failure of what it depends on; the cleanup lets the
// transaction go and aborts the request whatever happened.
async function underHeldLock(server: string, change: (tx: Prisma.TransactionClient) => Promise<void>, send: (signal: AbortSignal) => Promise<Reply>): Promise<Reply> {
  let locked!: () => void;
  let lockLost!: (reason: unknown) => void;
  const lockHeld = new Promise<void>((resolve, reject) => {
    locked = resolve;
    lockLost = reject;
  });
  let proceed!: () => void;
  let abandon!: (reason: unknown) => void;
  const waiterSeen = new Promise<void>((resolve, reject) => {
    proceed = resolve;
    abandon = reject;
  });

  waiterSeen.catch(() => {});

  const held = prisma.$transaction(
    async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${stand.userId}), hashtext(${server}))`;
      locked();
      await waiterSeen;
      await change(tx);
    },
    { timeout: 20_000 },
  );

  held.catch(lockLost);

  const aborter = new AbortController();
  const watching = new AbortController();
  let reply: Promise<Reply> | null = null;
  let waiter: Promise<void> | null = null;

  try {
    await lockHeld;
    reply = send(aborter.signal);
    waiter = waitForLockWaiter(watching.signal);
    await Promise.race([
      waiter,
      failureOf(held),
      reply.then(early => {
        throw new Error(`the command answered before the change was committed: ${early.status} ${early.text}`);
      }),
    ]);
    proceed();
    await held;

    return await reply;
  } finally {
    abandon(new Error('the scenario is over'));
    aborter.abort();
    watching.abort();
    await Promise.allSettled([held, reply, waiter]);
  }
}

function failureOf(promise: Promise<unknown>): Promise<never> {
  return promise.then(() => new Promise<never>(() => {}));
}

// Until a session of the stand's database waits for a lock — the command
// behind the lock the test holds — or until told to stop.
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
    throw new Error('no session of the stand came to wait for the lock');
  }
}

describe('a command over the row the screen showed', () => {
  const commands: [string, number, (id: string, signal: AbortSignal) => Promise<Reply>][] = [
    ['PATCH', 409, (id, signal) => stand.request('PATCH', `/api/connections/${id}`, { body: { name: 'Renamed' }, signal })],
    ['DELETE', 409, (id, signal) => stand.request('DELETE', `/api/connections/${id}`, { signal })],
    // The reconnect is by the row itself: a row gone is not found.
    ['reconnect', 404, (id, signal) => stand.request('POST', `/api/connections/${id}/reconnect`, { body: {}, signal })],
  ];

  for (const [label, status, send] of commands) {
    test(`${label} when the address belongs to another row by then: ${status}, the newcomer untouched`, { timeout: 30_000 }, async () => {
      const accountKey = `swap-${label.toLowerCase()}`;
      const shown = randomUUID();
      const newcomer = randomUUID();

      await prisma.connection.create({ data: { id: shown, userId: stand.userId, server: 'multi', accountKey, displayName: `Shown ${label}`, status: 'connected', identityId: `swap-${label}-1` } });

      const reply = await underHeldLock(
        'multi',
        async tx => {
          await tx.connection.delete({ where: { id: shown } });
          await tx.connection.create({ data: { id: newcomer, userId: stand.userId, server: 'multi', accountKey, displayName: 'Newcomer', status: 'connected', identityId: `swap-${label}-2` } });
        },
        signal => send(shown, signal),
      );

      assert.equal(reply.status, status, reply.text);
      assert.equal(reply.json<ErrorBody>().error.code, status === 409 ? 'replaced' : 'not_found');

      const row = await prisma.connection.findUnique({ where: { id: newcomer } });

      assert.ok(row, 'the newcomer stays');
      assert.equal(row.displayName, 'Newcomer');
      assert.equal(row.status, 'connected');
      assert.equal(row.connectNonce, null);
      assert.equal(row.threadId, null);

      const touched = (await connectionEvents()).filter(event => event.payload.connectionId === newcomer || event.payload.connectionId === shown);

      assert.deepEqual(touched, [], 'no event about either row');
    });
  }

  test('a row gone by the command: 404 for every command, and the reconnect does not bring it back', { timeout: 30_000 }, async () => {
    for (const [label, , send] of commands) {
      const accountKey = `gone-${label.toLowerCase()}`;
      const shown = randomUUID();

      await prisma.connection.create({ data: { id: shown, userId: stand.userId, server: 'multi', accountKey, displayName: `Gone ${label}`, status: 'connected', identityId: `gone-${label}` } });

      const reply = await underHeldLock(
        'multi',
        async tx => {
          await tx.connection.delete({ where: { id: shown } });
        },
        signal => send(shown, signal),
      );

      assert.equal(reply.status, 404, `${label}: ${reply.text}`);
      assert.equal(await prisma.connection.count({ where: { userId: stand.userId, server: 'multi', accountKey } }), 0, `${label}: the address stays free`);
    }
  });
});

describe('the rules of "Connect" hold at the write', () => {
  test('a nameless connect while another writer adds the service’s first account: refused, the newcomer not re-authorized', { timeout: 30_000 }, async () => {
    const reply = await underHeldLock(
      'race',
      async tx => {
        await tx.connection.create({ data: { userId: stand.userId, server: 'race', accountKey: 'default', displayName: 'race', status: 'connected' } });
      },
      signal => stand.request('POST', '/api/connections', { body: { server: 'race' }, signal }),
    );

    assert.equal(reply.status, 409, reply.text);
    assert.match(reply.json<ErrorBody>().error.message, /already has an account/);

    const rows = await prisma.connection.findMany({ where: { userId: stand.userId, server: 'race' } });

    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.connectNonce, null, 'no link was issued for the newcomer');
    assert.equal(rows[0]!.status, 'connected');
    assert.equal(rows[0]!.threadId, null);
    assert.deepEqual((await connectionEvents()).filter(event => event.payload.server === 'race'), []);
  });

  test('two named connects on a service of one account at once: one link, one refusal, one row', async () => {
    const replies = await Promise.all([
      stand.request('POST', '/api/connections', { body: { server: 'race2', name: 'Work' } }),
      stand.request('POST', '/api/connections', { body: { server: 'race2', name: 'Home' } }),
    ]);

    assert.deepEqual(replies.map(reply => reply.status).sort(), [200, 409], replies.map(reply => reply.text).join('\n'));
    assert.match(replies.find(reply => reply.status === 409)!.json<ErrorBody>().error.message, /at most one connected account/);
    assert.equal(await prisma.connection.count({ where: { userId: stand.userId, server: 'race2' } }), 1);
    assert.equal((await connectionEvents()).filter(event => event.type === 'connection.pending' && event.payload.server === 'race2').length, 1);
  });
});

describe('the callback’s identity refusal', () => {
  const ORIGIN = 'https://multi.example';
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  test('the consent of another provider account leaves the row as before the exchange, the link included; the next click restarts the flow', async () => {
    const { handleOauthCallback, handleConnectClick } = await import('../capabilities/connections/index.ts');
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + LINK_TTL_MS).toISOString();
    const tokens = { access_token: 'old-token', token_type: 'bearer', expires_in: 3600, obtained_at: new Date().toISOString() };

    await prisma.oauthClient.upsert({ where: { server: 'multi' }, create: { server: 'multi', clientInformation: { client_id: 'client-multi', redirect_uris: [`https://${DOMAIN}/oauth/callback`] } }, update: { clientInformation: { client_id: 'client-multi', redirect_uris: [`https://${DOMAIN}/oauth/callback`] } } });
    await prisma.connection.create({
      data: {
        id,
        userId: stand.userId,
        threadId: stand.mainThreadId,
        server: 'multi',
        accountKey: 'bound',
        displayName: 'Bound',
        status: 'connected',
        identityId: 'm-7',
        identity: { id: 'm-7', label: 'bound@multi.example' },
        tokens,
        metadata: { scope: 'read' },
        connectNonce: 'nonce-bound',
        pendingState: 'state-bound',
        pending: { expiresAt, codeVerifier: 'verifier-bound' },
      },
    });

    // The provider over a mocked fetch: no protected-resource metadata, the
    // authorization server at the origin, a token exchange that answers
    // fresh tokens, an identity probe that names another account.
    const exchanges: string[] = [];
    const fetched = mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : String(input));

      if (url.origin !== ORIGIN) {
        throw new Error(`unexpected fetch of ${url}`);
      }

      if (url.pathname.startsWith('/.well-known/oauth-authorization-server')) {
        return json({ issuer: ORIGIN, authorization_endpoint: `${ORIGIN}/authorize`, token_endpoint: `${ORIGIN}/token`, response_types_supported: ['code'], code_challenge_methods_supported: ['S256'] });
      }

      if (url.pathname === '/token') {
        exchanges.push(String(init?.body));

        return json({ access_token: 'other-token', token_type: 'bearer', expires_in: 3600, scope: 'read write' });
      }

      if (url.pathname === '/me') {
        return json({ id: 'm-9', email: 'other@multi.example' });
      }

      return json({ error: 'not_found' }, 404);
    });

    try {
      const result = await handleOauthCallback({ state: 'state-bound', code: 'code-bound' });

      assert.equal(result.ok, false);
      assert.match(result.error ?? '', /Authorized as "other@multi\.example", but account "bound" is bound to "bound@multi\.example"/);
      assert.equal(exchanges.length, 1, 'one token exchange');
      assert.match(exchanges[0]!, /code=code-bound/);
      assert.match(exchanges[0]!, /code_verifier=verifier-bound/);

      const row = await prisma.connection.findUniqueOrThrow({ where: { id } });

      assert.equal(row.status, 'connected');
      assert.equal(row.identityId, 'm-7');
      assert.deepEqual(row.tokens, tokens, 'the tokens as before the exchange');
      assert.deepEqual(row.metadata, { scope: 'read' });
      assert.equal(row.connectNonce, 'nonce-bound', 'the link lives');
      assert.equal(row.pendingState, null, 'the exchanged state is spent');
      assert.deepEqual(row.pending, { expiresAt, codeVerifier: 'verifier-bound' });

      const failed = (await connectionEvents()).filter(event => event.type === 'connection.failed' && event.payload.connectionId === id);

      assert.equal(failed.length, 1);
      assert.equal(failed[0]!.targetThreadId, stand.mainThreadId);
      assert.match(String(failed[0]!.payload.error), /bound to "bound@multi\.example"/);

      // The same link, clicked again: a fresh OAuth state, the consent page.
      const consent = await handleConnectClick('multi', 'nonce-bound');

      assert.match(consent, new RegExp(`^${ORIGIN.replace('.', '\\.')}/authorize\\?`));

      const clicked = await prisma.connection.findUniqueOrThrow({ where: { id } });

      assert.ok(clicked.pendingState, 'a new state for the restarted flow');
      assert.equal(clicked.connectNonce, 'nonce-bound');
    } finally {
      fetched.mock.restore();
    }
  });
});
