// Accounts authorized by a key, over the stand (src/test-support/stand.ts):
// "Connect" on such a service answers a link to the secrets form of the
// account's own row, and the form's request is that row while its link is
// open; a key the provider refuses, a key nobody could check and an empty
// one are not stored and the row stays; an accepted key connects the
// account, names it by the provider's answer and journals
// connection.completed; the key is what a call of the account acts with,
// and a key the provider refuses on a call sends the account to be
// authorized again, and a refusal that meets the user entering a new key
// never takes the new key down; a key of another provider account than the one the row
// is bound to is refused; a key of an account that already lives in another
// row goes to that row and the row born by the link dies; a service without
// an identity probe stores the key as it is and holds one account. The
// provider's identity endpoint is a mocked fetch that reads the key from
// the Authorization header as the service's probe sends it.
//
// Run: npm test  (node:test, native type stripping — no build needed).

import { test, describe, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startStand } from '../test-support/stand.ts';
import type { Stand } from '../test-support/stand.ts';
import type { ConnectLinkResponse, SecretRequestResponse } from './contract.ts';

type ErrorBody = { error: { code: string; message: string } };

let stand: Stand;
let prisma: typeof import('../db/client.ts')['prisma'];
let connections: typeof import('../capabilities/connections/index.ts');
let fetched: ReturnType<typeof mock.method>;

const DOMAIN = 'balabash.test';
const DAY_MS = 24 * 60 * 60 * 1000;
const PROBE = 'https://shop.example/me';

// The provider's accounts by key; any other key is refused, "down" finds
// the provider failing.
const SHOPS: Record<string, { sid: string; name: string }> = {
  'key-a': { sid: 's-1', name: 'Shop A' },
  'key-a2': { sid: 's-1', name: 'Shop A' },
  'key-b': { sid: 's-2', name: 'Shop B' },
};
const probed: string[] = [];

before(async () => {
  stand = await startStand();
  ({ prisma } = await import('../db/client.ts'));
  process.env.CONSOLE_DOMAIN = DOMAIN;
  process.env.MAIN_OPENAI_MODEL ??= 'test-model';
  connections = await import('../capabilities/connections/index.ts');

  const { registerAccountService } = await import('../capabilities/connections/services.ts');
  const base = { setup: null, url: '', clientRegistration: 'dynamic' as const, scope: null, authorizationParams: null };

  registerAccountService({
    ...base,
    name: 'shop',
    description: 'shop service',
    identityProbe: { url: PROBE, idField: 'sid', labelField: 'name', authScheme: 'none' },
    key: { label: 'API token', instructions: 'Create it in the seller cabinet.' },
  });
  registerAccountService({ ...base, name: 'plain', description: 'plain service', identityProbe: null, key: { label: 'API key', instructions: null } });
  registerAccountService({ ...base, name: 'oauthy', description: 'oauthy service', url: 'https://oauthy.example/mcp', identityProbe: null, key: null });

  fetched = mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);

    if (url !== PROBE) {
      throw new Error(`unexpected fetch of ${url}`);
    }

    const key = new Headers(init?.headers).get('authorization') ?? '';
    const shop = SHOPS[key];

    probed.push(key);

    if (key === 'down') {
      return new Response('{}', { status: 503 });
    }

    return new Response(JSON.stringify(shop ?? { error: 'unauthorized' }), { status: shop ? 200 : 401, headers: { 'content-type': 'application/json' } });
  });
});

after(async () => {
  fetched.mock.restore();
  await stand.stop();
});

async function events(connectionId: string): Promise<{ type: string; targetThreadId: string | null; payload: Record<string, unknown> }[]> {
  const rows = await prisma.event.findMany({ where: { type: { startsWith: 'connection.' } }, orderBy: { seq: 'asc' } });

  return rows
    .map(event => ({ type: event.type, targetThreadId: event.targetThreadId, payload: event.payload as Record<string, unknown> }))
    .filter(event => event.payload.connectionId === connectionId);
}

async function connect(server: string, name?: string): Promise<ConnectLinkResponse> {
  const reply = await stand.request('POST', '/api/connections', { body: name ? { server, name } : { server } });

  assert.equal(reply.status, 200, reply.text);

  return reply.json<ConnectLinkResponse>();
}

const enter = (id: string, key: string) => stand.request('POST', `/api/secret-requests/${id}`, { body: { values: { key } } });

describe('an account authorized by a key', () => {
  let first: string;

  test('"Connect" answers a link to the secrets form of the account’s row, and the row is the request', async () => {
    const link = await connect('shop');

    first = link.connection.id;
    assert.equal(link.url, `https://${DOMAIN}/secrets/${first}?ws=${stand.workspaceId}`);
    assert.equal(link.connection.status, 'pending');
    assert.equal(link.connection.accountKey, 'default');
    assert.ok(Math.abs(link.expiresAt.getTime() - (Date.now() + DAY_MS)) < 60_000, 'the link lives a day');

    const form = await stand.request('GET', `/api/secret-requests/${first}`);

    assert.equal(form.status, 200, form.text);
    assert.deepEqual(form.json<SecretRequestResponse>().request, {
      id: first,
      kind: 'account-key',
      server: 'shop',
      fields: [{ key: 'key', label: 'API token', description: 'Create it in the seller cabinet.', required: true, secret: true }],
    });

    assert.deepEqual((await events(first)).map(event => event.type), ['connection.pending']);
  });

  test('a key the provider refuses, a key nobody could check and an empty one are not stored', async () => {
    const refused = await enter(first, 'wrong');

    assert.equal(refused.status, 400, refused.text);
    assert.equal(refused.json<ErrorBody>().error.code, 'provisioning_failed');
    assert.match(refused.json<ErrorBody>().error.message, /shop refused the key \(HTTP 401\)/);

    const down = await enter(first, 'down');

    assert.equal(down.status, 400, down.text);
    assert.match(down.json<ErrorBody>().error.message, /could not be checked at shop/);

    const empty = await enter(first, '   ');

    assert.equal(empty.status, 400, empty.text);
    assert.match(empty.json<ErrorBody>().error.message, /API token is required/);

    const row = await prisma.connection.findUniqueOrThrow({ where: { id: first } });

    assert.equal(row.status, 'pending');
    assert.equal(row.tokens, null);
    assert.ok(row.connectNonce, 'the link is still open');
    assert.deepEqual((await events(first)).map(event => event.type), ['connection.pending']);
  });

  test('an accepted key connects the account under the provider’s name and closes the request', async () => {
    const saved = await enter(first, '  key-a  ');

    assert.equal(saved.status, 200, saved.text);
    assert.equal(probed.at(-1), 'key-a', 'the key goes bare and trimmed');

    const row = await prisma.connection.findUniqueOrThrow({ where: { id: first } });

    assert.equal(row.status, 'connected');
    assert.deepEqual(row.tokens, { access_token: 'key-a' });
    assert.equal(row.identityId, 's-1');
    assert.equal(row.connectNonce, null);
    assert.equal(row.pending, null);

    const completed = (await events(first)).at(-1)!;

    assert.equal(completed.type, 'connection.completed');
    assert.equal(completed.targetThreadId, stand.mainThreadId);
    assert.equal(completed.payload.account, 'default');
    assert.equal(completed.payload.status, 'connected');
    assert.equal(completed.payload.identity, 'Shop A');
    assert.ok(!JSON.stringify(completed.payload).includes('key-a'), 'the key is not in the log');

    const form = await stand.request('GET', `/api/secret-requests/${first}`);
    const again = await enter(first, 'key-a');

    assert.equal(form.status, 404, form.text);
    assert.equal(again.status, 404, again.text);
  });

  test('a call acts with the key; a key the provider refuses on a call sends the account to be authorized again', async () => {
    const row = { id: first, server: 'shop' };

    assert.equal(await connections.accountAccessToken(row, ''), 'key-a');
    assert.equal(await connections.accountAccessToken(row, '', 'an-older-key'), 'key-a', 'a newer key than the refused one is the answer');
    await assert.rejects(connections.accountAccessToken(row, '', 'key-a'), /shop no longer accepts the key of the account/);

    assert.equal((await prisma.connection.findUniqueOrThrow({ where: { id: first } })).status, 'reauthorization_required');
    assert.equal((await events(first)).at(-1)!.type, 'connection.reauthorization_required');
    await assert.rejects(connections.accountAccessToken(row, ''), /the account holds no key/);
  });

  test('a key of another provider account is refused for a bound row; the account’s own new key reconnects it', async () => {
    const reply = await stand.request('POST', `/api/connections/${first}/reconnect`);

    assert.equal(reply.status, 200, reply.text);
    assert.equal(reply.json<ConnectLinkResponse>().url, `https://${DOMAIN}/secrets/${first}?ws=${stand.workspaceId}`);

    const other = await enter(first, 'key-b');

    assert.equal(other.status, 400, other.text);
    assert.match(other.json<ErrorBody>().error.message, /belongs to "Shop B", but account "default" is bound to "Shop A"/);
    assert.deepEqual((await prisma.connection.findUniqueOrThrow({ where: { id: first } })).tokens, { access_token: 'key-a' });

    const own = await enter(first, 'key-a2');

    assert.equal(own.status, 200, own.text);

    const row = await prisma.connection.findUniqueOrThrow({ where: { id: first } });

    assert.equal(row.status, 'connected');
    assert.deepEqual(row.tokens, { access_token: 'key-a2' });
    assert.equal(await connections.accountAccessToken({ id: first, server: 'shop' }, ''), 'key-a2');
  });

  test('a refusal of the key the user is replacing at that very moment leaves the new key connected', async () => {
    const row = { id: first, server: 'shop' };
    let current = 'key-a2';

    // The two meet in every order over the rounds: the refusal of the old
    // key arrives before the form's write, during it, and after it.
    for (let round = 0; round < 30; round += 1) {
      const next = current === 'key-a' ? 'key-a2' : 'key-a';
      const link = await stand.request('POST', `/api/connections/${first}/reconnect`);

      assert.equal(link.status, 200, link.text);

      const late = new Promise(resolve => setTimeout(resolve, round % 15)).then(() => connections.accountAccessToken(row, '', current).catch(() => null));
      const [saved] = await Promise.all([enter(first, next), late]);

      assert.equal(saved.status, 200, saved.text);

      const after = await prisma.connection.findUniqueOrThrow({ where: { id: first } });

      assert.deepEqual([after.status, after.tokens], ['connected', { access_token: next }], `round ${round}`);
      current = next;
    }
  });

  test('a key of an account that already lives in another row goes to that row; the row born by the link dies', async () => {
    const link = await connect('shop', 'Second');
    const born = link.connection.id;
    const saved = await enter(born, 'key-a');

    assert.equal(saved.status, 200, saved.text);
    assert.equal(await prisma.connection.findUnique({ where: { id: born } }), null);
    assert.deepEqual((await prisma.connection.findUniqueOrThrow({ where: { id: first } })).tokens, { access_token: 'key-a' });

    const journaled = await prisma.event.findMany({ where: { type: { in: ['connection.disconnected', 'connection.completed'] } }, orderBy: { seq: 'asc' } });
    const [gone, completed] = journaled.slice(-2).map(event => ({ type: event.type, payload: event.payload as Record<string, unknown> }));

    assert.equal(gone!.type, 'connection.disconnected');
    assert.equal(gone!.payload.connectionId, born);
    assert.equal(gone!.payload.reason, 'duplicate');
    assert.equal(completed!.type, 'connection.completed');
    assert.equal(completed!.payload.connectionId, first);
    assert.equal(completed!.payload.alreadyConnected, true);
    assert.equal(completed!.payload.requestedAccount, 'second');
  });

  test('another provider account is one more account of the workspace', async () => {
    const link = await connect('shop', 'Other shop');
    const saved = await enter(link.connection.id, 'key-b');

    assert.equal(saved.status, 200, saved.text);

    const rows = await prisma.connection.findMany({ where: { workspaceId: stand.workspaceId, server: 'shop' }, orderBy: { createdAt: 'asc' } });

    assert.deepEqual(rows.map(row => [row.accountKey, row.status, row.identityId]), [['default', 'connected', 's-1'], ['other-shop', 'connected', 's-2']]);
  });
});

describe('a key service without an identity probe', () => {
  test('stores the key as it is entered and holds one account', async () => {
    const link = await connect('plain');
    const before = probed.length;
    const saved = await enter(link.connection.id, 'anything');

    assert.equal(saved.status, 200, saved.text);
    assert.equal(probed.length, before, 'nobody is asked');

    const row = await prisma.connection.findUniqueOrThrow({ where: { id: link.connection.id } });

    assert.equal(row.status, 'connected');
    assert.deepEqual(row.tokens, { access_token: 'anything' });
    assert.equal(row.identityId, null);

    const second = await stand.request('POST', '/api/connections', { body: { server: 'plain', name: 'Second' } });

    assert.equal(second.status, 409, second.text);
  });
});

describe('what is not a key request', () => {
  test('a row of an OAuth service, another workspace’s row, an unknown id and an expired link are not found alike', async () => {
    const oauth = await connect('oauthy');

    assert.match(oauth.url, new RegExp(`^https://${DOMAIN.replace('.', '\\.')}/connect/oauthy\\?nonce=`));

    const foreign = randomUUID();

    await prisma.connection.create({
      data: { id: foreign, workspaceId: randomUUID(), server: 'shop', accountKey: 'default', displayName: 'Foreign', status: 'pending', connectNonce: randomUUID(), pending: { expiresAt: new Date(Date.now() + DAY_MS).toISOString() } },
    });

    const expired = await connect('shop', 'Late');

    await prisma.connection.update({ where: { id: expired.connection.id }, data: { pending: { expiresAt: new Date(Date.now() - 1000).toISOString() } } });

    for (const id of [oauth.connection.id, foreign, randomUUID(), expired.connection.id]) {
      const form = await stand.request('GET', `/api/secret-requests/${id}`);
      const entered = await enter(id, 'key-b');

      assert.equal(form.status, 404, form.text);
      assert.equal(entered.status, 404, entered.text);
    }

    assert.equal((await prisma.connection.findUniqueOrThrow({ where: { id: foreign } })).tokens, null);
  });

  test('the sign-in link of an OAuth service does not open a key service', async () => {
    const row = await prisma.connection.findFirstOrThrow({ where: { workspaceId: stand.workspaceId, server: 'shop', accountKey: 'late' } });

    await assert.rejects(connections.handleConnectClick('shop', row.connectNonce!), /connected with a key, not a sign-in/);
  });
});
