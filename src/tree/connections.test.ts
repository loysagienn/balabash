// The connections of the tree over the stand's database: the node
// `connections`, the connections port of the catalog over the app's
// connections layer, and the first node that lives on a connection —
// `web_perplexity`. Everything is called the way every caller reaches it:
// through a grant and the one path of a call (src/catalog).
//
// The tree of the test declares its own services next to the real nodes: an
// account service with a manual OAuth client and an identity probe
// (`mailbox`, several accounts), one the provider registers itself
// (`notes`, a single account) and Perplexity over a server of the test. The
// outside is local: an authorization server that renews tokens and an MCP
// server that answers as Perplexity does. No consent page is walked — an
// account becomes connected the way the callback leaves it, by its row.
//
// Run: npm test  (node:test, native type stripping — no build needed).

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { z } from 'zod';
import {
  CapabilityError,
  accountAuthority,
  buildCatalog,
  capability,
  computeGrant,
  invokeCapability,
  node,
} from '../catalog/index.ts';
import type { Catalog, ConnectionsPort, ErrorKind, Grant } from '../catalog/index.ts';
import type { JsonObject } from '../core/contract.ts';
import { closeServer, listen, startStand } from '../test-support/stand.ts';
import type { Stand } from '../test-support/stand.ts';

const DOMAIN = 'console.test';

let stand: Stand;
let prisma: typeof import('../db/client.ts')['prisma'];
let layer: typeof import('../capabilities/connections/index.ts');
let secrets: typeof import('../capabilities/external-secrets.ts');
let catalog: Catalog;
let port: ConnectionsPort;
let outside: http.Server;
let origin: string;

type Value = Record<string, any>;

const caller = () => ({ workspaceId: stand.workspaceId, threadId: stand.mainThreadId, agentName: 'auth' });

// The grant as of now: what is connected decides which nodes it holds.
function grantNow(): Promise<Grant> {
  return computeGrant(catalog, { allows: () => true, actions: ['describe', 'call'] }, { caller: caller(), connections: port });
}

async function invoke(name: string, input: JsonObject = {}): Promise<Value> {
  return invokeCapability(await grantNow(), name, input, { connections: port }) as Promise<Value>;
}

async function refuses(call: Promise<unknown>, kind: ErrorKind, message: RegExp): Promise<void> {
  await assert.rejects(call, (error: unknown) => {
    assert.ok(error instanceof CapabilityError, `a CapabilityError, got ${String(error)}`);
    assert.equal(error.kind, kind, error.message);
    assert.match(error.message, message);

    return true;
  });
}

async function events(prefix: string) {
  const rows = await prisma.event.findMany({ where: { type: { startsWith: prefix } }, orderBy: { seq: 'asc' } });

  return rows.map(row => [row.type, row.targetThreadId ?? row.threadId, (row.payload as Value).account ?? (row.payload as Value).server]);
}

const requestIdOf = (url: string) => decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '');

// An account as the OAuth callback leaves it: connected, with its tokens.
async function connect(service: string, account: string, tokens: Value): Promise<void> {
  await prisma.connection.update({
    where: { workspaceId_server_accountKey: { workspaceId: stand.workspaceId, server: service, accountKey: account } },
    data: { status: 'connected', tokens: { token_type: 'Bearer', obtained_at: new Date().toISOString(), ...tokens } },
  });
}

async function rowOf(service: string, account: string) {
  return prisma.connection.findUnique({
    where: { workspaceId_server_accountKey: { workspaceId: stand.workspaceId, server: service, accountKey: account } },
  });
}

// ---------------------------------------------------------------------------
// The outside: an authorization server and Perplexity's MCP server

const seen: { refreshes: string[]; mcp: Array<{ authorization: string | undefined; name: string; args: Value }> } = {
  refreshes: [],
  mcp: [],
};
// How the MCP server answers a tool: its result, or an HTTP status.
let perplexity: (name: string, args: Value) => Value | number = () => 500;

async function bodyOf(request: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString('utf8');
}

function json(response: http.ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

async function serve(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
  const { pathname } = new URL(request.url ?? '/', origin);

  if (pathname === '/.well-known/oauth-authorization-server') {
    return json(response, 200, {
      issuer: origin,
      authorization_endpoint: `${origin}/authorize`,
      token_endpoint: `${origin}/token`,
      response_types_supported: ['code'],
    });
  }

  if (pathname === '/token' && request.method === 'POST') {
    const refreshToken = new URLSearchParams(await bodyOf(request)).get('refresh_token') ?? '';

    seen.refreshes.push(refreshToken);

    return refreshToken === 'good-refresh'
      ? json(response, 200, { access_token: `fresh-${seen.refreshes.length}`, token_type: 'Bearer', expires_in: 3600 })
      : json(response, 400, { error: 'invalid_grant', error_description: 'Token has been revoked' });
  }

  if (pathname === '/mcp' && request.method === 'POST') {
    const message = JSON.parse(await bodyOf(request)) as Value;

    if (message.method === 'initialize') {
      return json(response, 200, {
        jsonrpc: '2.0',
        id: message.id,
        result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'perplexity', version: '1' } },
      });
    }

    if (message.method === 'tools/call') {
      const { name, arguments: args } = message.params;

      seen.mcp.push({ authorization: request.headers.authorization, name, args });

      const answer = request.headers.authorization === 'Bearer key-1' ? perplexity(name, args) : 401;

      return typeof answer === 'number'
        ? json(response, answer, { error: 'refused' })
        : json(response, 200, { jsonrpc: '2.0', id: message.id, result: answer });
    }

    response.writeHead(202).end();

    return;
  }

  response.writeHead(pathname === '/mcp' ? 405 : 404).end();
}

// ---------------------------------------------------------------------------

before(async () => {
  stand = await startStand();
  process.env.CONSOLE_DOMAIN = DOMAIN;
  ({ prisma } = await import('../db/client.ts'));
  layer = await import('../capabilities/connections/index.ts');
  secrets = await import('../capabilities/external-secrets.ts');

  outside = http.createServer((request, response) => {
    serve(request, response).catch(error => json(response, 500, { error: String(error) }));
  });
  origin = `http://127.0.0.1:${(await listen(outside, 0, '127.0.0.1')).port}`;

  const { connections } = await import('./connections.ts');
  const { webNode } = await import('./web.ts');
  const { perplexityNode } = await import('./web-perplexity.ts');
  const services = await import('./services.ts');
  const token = () =>
    capability({
    name: 'token',
    summary: 'Say which access the call acts with',
    description: 'Say which access the call acts with.',
    input: z.strictObject({ rejected: z.string().optional() }),
    output: z.strictObject({ token: z.string() }),
    run: async (input, ctx) => ({ token: await accountAuthority(ctx).accessToken(input.rejected) }),
    });

  catalog = buildCatalog({
    summary: 'The tree of the test.',
    children: [
      connections,
      node({
        name: 'mailbox',
        summary: 'A mailbox of the user.',
        connection: {
          type: 'account',
          service: 'mailbox',
          summary: 'Mail of the user.',
          setup: 'Register an app at the provider.',
          oauth: {
            url: origin,
            clientRegistration: 'manual',
            scope: 'mail',
            identityProbe: { url: `${origin}/me`, idField: 'id' },
          },
        },
        children: [token()],
      }),
      node({
        name: 'notes',
        summary: 'Notes of the user.',
        connection: {
          type: 'account',
          service: 'notes',
          summary: 'Notes of the user.',
          oauth: { url: origin, clientRegistration: 'dynamic' },
        },
        children: [token()],
      }),
      webNode(undefined, perplexityNode(`${origin}/mcp`)),
    ],
  }).catalog;
  services.registerServices(catalog);
  port = services.connectionsPort();
});

after(async () => {
  await closeServer(outside);
  await stand.stop();
});

describe('connections: what can be connected', () => {
  test('lists the services of the tree with their state; a node waits for its connection', async () => {
    assert.deepEqual(await invoke('connections_list'), {
      accountServices: [
        { service: 'mailbox', summary: 'Mail of the user.', oauthClient: 'missing', multipleAccounts: true, accounts: [] },
        { service: 'notes', summary: 'Notes of the user.', oauthClient: 'dynamic', multipleAccounts: false, accounts: [] },
      ],
      installationServices: [
        {
          service: 'perplexity',
          summary: 'Web search and web-grounded answers of Perplexity, on the API key of the installation.',
          secretNames: ['PERPLEXITY_API_KEY'],
          status: 'secrets_missing',
          error: null,
        },
      ],
    });

    const grant = await grantNow();

    assert.equal(grant.vertices.has('connections'), true);
    assert.equal(grant.vertices.has('mailbox'), false);
    assert.equal(grant.vertices.has('web_perplexity'), false);
    assert.equal(grant.vertices.has('web_get'), true);
  });

  test('the OAuth client of the installation is asked for through a link; a service without one authorizes nobody', async () => {
    await refuses(invoke('connections_authorize', { service: 'mailbox' }), 'conflict', /needs installation OAuth client credentials/);
    await refuses(invoke('connections_request_oauth_client', { service: 'drive' }), 'not_found', /^There is no account service "drive"\. Account services: mailbox, notes\.$/);
    await refuses(invoke('connections_request_oauth_client', { service: 'notes' }), 'invalid_input', /registers its OAuth client at the provider itself/);

    const asked = await invoke('connections_request_oauth_client', { service: 'mailbox' });

    assert.match(asked.url, /^https:\/\/console\.test\/secrets\/[^?]+\?ws=/);
    assert.deepEqual([asked.replacing, asked.setup], [false, 'Register an app at the provider.']);

    await layer.provisionOauthClient(stand.workspaceId, requestIdOf(asked.url), 'client-1', 'secret-1');

    assert.equal((await invoke('connections_request_oauth_client', { service: 'mailbox' })).replacing, true);
    assert.equal((await invoke('connections_list')).accountServices[0].oauthClient, 'provisioned');
    assert.deepEqual(await events('oauth_client.'), [
      ['oauth_client.requested', stand.mainThreadId, 'mailbox'],
      ['oauth_client.provisioned', stand.mainThreadId, 'mailbox'],
      ['oauth_client.requested', stand.mainThreadId, 'mailbox'],
    ]);
  });
});

describe('connections: the accounts of a service', () => {
  test('a link for the first account, for one more by its name, for an existing one by its address', async () => {
    const first = await invoke('connections_authorize', { service: 'mailbox' });

    assert.match(first.url, /^https:\/\/console\.test\/connect\/mailbox\?nonce=/);
    assert.ok(Date.parse(first.expiresAt) > Date.now());
    assert.deepEqual(first.account, { account: 'default', name: 'mailbox', identity: null, status: 'pending' });

    // The only account is the one a link without an address is for.
    assert.equal((await invoke('connections_authorize', { service: 'mailbox' })).account.account, 'default');

    const second = await invoke('connections_authorize', { service: 'mailbox', name: ' Work mail ' });

    assert.deepEqual(second.account, { account: 'work-mail', name: 'Work mail', identity: null, status: 'pending' });
    assert.deepEqual((await invoke('connections_authorize', { service: 'mailbox', account: 'work-mail' })).account, second.account);
    assert.deepEqual(
      (await port.accounts(stand.workspaceId, 'mailbox')).map(account => account.account),
      ['default', 'work-mail'],
    );
    assert.deepEqual((await events('connection.')).at(-1), ['connection.pending', stand.mainThreadId, 'work-mail']);
  });

  test('refuses a link nobody can tell the account of', async () => {
    const call = (input: JsonObject) => invoke('connections_authorize', { service: 'mailbox', ...input });

    await refuses(call({}), 'invalid_input', /^"mailbox" has several accounts: pass account .* Accounts: default — "mailbox", pending; work-mail — "Work mail", pending\.$/);
    await refuses(call({ account: 'home' }), 'not_found', /^No account "home" in "mailbox"\. Accounts: default/);
    await refuses(call({ account: 'default', name: 'Home' }), 'invalid_input', /at most one of: account, name/i);
    await refuses(call({ name: '  ' }), 'invalid_input', /^name is blank/);
    await refuses(call({ name: 'work MAIL' }), 'conflict', /Name "work MAIL" is already used by account "work-mail"/);
    await refuses(invoke('connections_authorize', { service: 'drive' }), 'not_found', /^There is no account service "drive"/);

    // A service without an identity probe holds one account.
    await invoke('connections_authorize', { service: 'notes' });
    await refuses(invoke('connections_authorize', { service: 'notes', name: 'Second' }), 'conflict', /holds at most one connected account/);
  });

  test('renames an account and disconnects it; the address stays, then becomes free', async () => {
    const renamed = await invoke('connections_rename', { service: 'mailbox', account: 'work-mail', name: 'Office' });

    assert.deepEqual(renamed, {
      account: { account: 'work-mail', name: 'Office', identity: null, status: 'pending' },
      previousName: 'Work mail',
    });
    await refuses(invoke('connections_rename', { service: 'mailbox', account: 'work-mail', name: 'MAILBOX' }), 'conflict', /Name "MAILBOX" is already used by account "default"/);
    await refuses(invoke('connections_rename', { service: 'mailbox', account: 'home', name: 'Home' }), 'not_found', /No account "home" of "mailbox"/);
    await refuses(invoke('connections_rename', { service: 'mailbox', account: 'default', name: ' ' }), 'invalid_input', /^name is blank/);

    assert.deepEqual(await invoke('connections_disconnect', { service: 'notes', account: 'default' }), { name: 'notes' });
    await refuses(invoke('connections_disconnect', { service: 'notes', account: 'default' }), 'not_found', /No account "default" of "notes"/);
    assert.deepEqual(await port.accounts(stand.workspaceId, 'notes'), []);
    assert.deepEqual((await events('connection.')).slice(-2), [
      ['connection.renamed', stand.mainThreadId, 'work-mail'],
      ['connection.disconnected', stand.mainThreadId, 'default'],
    ]);
  });
});

describe('the authority of an account', () => {
  test('a call acts with the access of the account it names, renewed when the provider refuses it', async () => {
    await connect('mailbox', 'default', { access_token: 'home-1', refresh_token: 'good-refresh', expires_in: 3600 });
    await connect('mailbox', 'work-mail', { access_token: 'work-1', refresh_token: 'good-refresh', expires_in: 3600 });

    assert.equal((await grantNow()).vertices.has('mailbox_token'), true);
    assert.deepEqual(await invoke('mailbox_token', { account: 'default' }), { token: 'home-1' });
    assert.deepEqual(await invoke('mailbox_token', { account: 'work-mail' }), { token: 'work-1' });
    assert.deepEqual(seen.refreshes, []);

    // The provider has just refused the token: the answer is a new one, and
    // it is the one stored. A token another call has renewed meanwhile is
    // answered without a second exchange.
    assert.deepEqual(await invoke('mailbox_token', { account: 'default', rejected: 'home-1' }), { token: 'fresh-1' });
    assert.deepEqual(await invoke('mailbox_token', { account: 'default', rejected: 'home-1' }), { token: 'fresh-1' });
    assert.deepEqual(await invoke('mailbox_token', { account: 'default' }), { token: 'fresh-1' });
    assert.deepEqual(seen.refreshes, ['good-refresh']);
    assert.deepEqual(await invoke('mailbox_token', { account: 'work-mail' }), { token: 'work-1' });

    // A token about to expire is renewed before it is handed out.
    await connect('mailbox', 'work-mail', {
      access_token: 'work-old',
      refresh_token: 'good-refresh',
      expires_in: 3600,
      obtained_at: new Date(Date.now() - 3_590_000).toISOString(),
    });
    assert.deepEqual(await invoke('mailbox_token', { account: 'work-mail' }), { token: 'fresh-2' });
  });

  test('an account whose authorization is gone answers auth_required and waits for the user', async () => {
    await connect('mailbox', 'work-mail', { access_token: 'work-2', refresh_token: 'dead-refresh', expires_in: 3600 });

    await refuses(
      invoke('mailbox_token', { account: 'work-mail', rejected: 'work-2' }),
      'auth_required',
      /^The account "work-mail" of "mailbox" can no longer act: the provider no longer honors the refresh token \(Token has been revoked\)\. The user has to authorize it again\.$/,
    );
    assert.equal((await rowOf('mailbox', 'work-mail'))?.status, 'reauthorization_required');
    assert.deepEqual((await events('connection.')).at(-1), ['connection.reauthorization_required', stand.mainThreadId, 'work-mail']);

    // The path of a call refuses the account from now on, before any action.
    await refuses(invoke('mailbox_token', { account: 'work-mail' }), 'auth_required', /is not connected \(reauthorization_required\)/);
    assert.deepEqual(await invoke('mailbox_token', { account: 'default' }), { token: 'fresh-1' });
  });
});

describe('the secrets of the installation and web_perplexity', () => {
  test('the secrets are entered through a link; the node appears with them and acts with them', async () => {
    await refuses(invoke('connections_request_secret', { service: 'mailbox' }), 'not_found', /^There is no installation service "mailbox" that takes secrets\. Installation services: perplexity\.$/);

    const asked = await invoke('connections_request_secret', { service: 'perplexity' });

    assert.match(asked.url, /^https:\/\/console\.test\/secrets\/[^?]+\?ws=/);
    await secrets.provisionExternalServerSecrets(stand.workspaceId, requestIdOf(asked.url), { PERPLEXITY_API_KEY: 'key-1' });

    assert.equal((await invoke('connections_list')).installationServices[0].status, 'connected');
    assert.equal((await grantNow()).vertices.has('web_perplexity_search'), true);

    perplexity = name => ({
      content: [{ type: 'text', text: `text of ${name}` }],
      ...(name === 'perplexity_search' ? { structuredContent: { results: '1. A page\nhttps://a.test\nAn excerpt' } } : {}),
    });

    assert.deepEqual(await invoke('web_perplexity_search', { query: 'kites', search_recency_filter: 'week' }), {
      results: '1. A page\nhttps://a.test\nAn excerpt',
    });
    assert.deepEqual(seen.mcp.at(-1), {
      authorization: 'Bearer key-1',
      name: 'perplexity_search',
      args: { query: 'kites', max_results: 10, max_tokens_per_page: 1024, search_recency_filter: 'week', search_type: 'web' },
    });

    // A server that gives no structured content answers with its text.
    const question = { messages: [{ role: 'user', content: 'Why is the sky blue?' }] };

    assert.deepEqual(await invoke('web_perplexity_ask', question), { response: 'text of perplexity_ask' });
    assert.deepEqual(await invoke('web_perplexity_research', question), { response: 'text of perplexity_research' });
    assert.deepEqual(seen.mcp.at(-1)?.args, question);
    await refuses(invoke('web_perplexity_search', { query: 'kites', max_results: 50 }), 'invalid_input', /max_results/);
  });

  test('a refusal of the server, a refused key and a silent server are three different errors', async () => {
    perplexity = () => ({ content: [{ type: 'text', text: 'Quota exhausted' }], isError: true });
    await refuses(invoke('web_perplexity_reason', { messages: [] }), 'external_error', /^Perplexity refused the request: Quota exhausted$/);

    perplexity = () => ({ content: [] });
    await refuses(invoke('web_perplexity_search', { query: 'x' }), 'external_error', /^Perplexity answered `perplexity_search` with no text\.$/);

    perplexity = () => 401;
    await refuses(invoke('web_perplexity_search', { query: 'x' }), 'auth_required', /^Perplexity refused the credentials of the installation \(HTTP 401\)/);

    perplexity = () => 500;
    await refuses(invoke('web_perplexity_search', { query: 'x' }), 'external_error', /^Perplexity refused the request \(HTTP 500\)/);

    const cancelled = AbortSignal.abort();

    await refuses(
      invokeCapability(await grantNow(), 'web_perplexity_search', { query: 'x' }, { connections: port, signal: cancelled }),
      'unavailable',
      /^The call to Perplexity was cancelled/,
    );
  });

  test('forgotten secrets disconnect the service for everyone: the node is cut, a call under an older grant is refused', async () => {
    const before = await grantNow();
    const calls = seen.mcp.length;

    assert.deepEqual(await invoke('connections_forget_secret', { service: 'perplexity' }), { deleted: 1 });
    assert.equal((await invoke('connections_list')).installationServices[0].status, 'secrets_missing');
    assert.equal((await grantNow()).vertices.has('web_perplexity'), false);
    await refuses(
      invokeCapability(before, 'web_perplexity_search', { query: 'x' }, { connections: port }),
      'auth_required',
      /^The installation secrets of "perplexity" are not entered \(PERPLEXITY_API_KEY\): the operator has to enter them\.$/,
    );
    assert.equal(seen.mcp.length, calls);
    await refuses(invoke('connections_forget_secret', { service: 'qase' }), 'not_found', /^There is no installation service "qase"/);
  });
});
