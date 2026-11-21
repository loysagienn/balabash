import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, beforeEach, test } from 'node:test';
import {
  buildCatalog,
  computeGrant,
  describe,
  invokeCapability,
  type ConnectionsPort,
  type Grant,
  type JsonObject,
} from '../catalog/index.ts';
import { closeServer, listen, startStand, type Stand } from '../test-support/stand.ts';
import { notionNode } from './notion.ts';

let stand: Stand;
let grant: Grant;
let server: http.Server;
let result: JsonObject;
let rejectToken: string | null;
let deleteStatus: number;
let toolsCalled: Array<{ token: string; tool: string; input: JsonObject }>;
let ended: string[];
let opened: string[];
let tokens: Array<string | undefined>;
let hasAccount = true;
const account = { account: 'work', name: 'Work', status: 'connected' as const, identity: null };
const connections: ConnectionsPort = {
  accounts: async () => (hasAccount ? [account] : []),
  secretsReady: async () => false,
  secretAuthority: async () => {
    throw new Error('unexpected secret');
  },
  accountAuthority: async (ws, service, address) => {
    assert.deepEqual([ws, service, address], [stand.workspaceId, 'notion', 'work']);
    return {
      type: 'account',
      accessToken: async rejected => {
        tokens.push(rejected);
        return rejected === undefined ? 'first' : 'fresh';
      },
    };
  },
};

before(async () => {
  stand = await startStand();
  server = http.createServer(async (req, res) => {
    if (req.method === 'DELETE') {
      ended.push(String(req.headers['mcp-session-id']));
      res.writeHead(deleteStatus).end();
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const message = JSON.parse(Buffer.concat(chunks).toString());
    if (message.method === 'notifications/initialized') {
      res.writeHead(202).end();
      return;
    }
    let reply;
    if (message.method === 'initialize') {
      const id = 'session-' + (opened.length + 1);
      opened.push(id);
      res.setHeader('mcp-session-id', id);
      reply = {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'notion', version: '1' },
      };
    } else {
      const token = String(req.headers.authorization);
      toolsCalled.push({ tool: message.params.name, input: message.params.arguments, token });
      if (token === rejectToken || rejectToken === '*') {
        res.writeHead(401).end();
        return;
      }
      reply = result;
    }
    res
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: reply }));
  });
  const port = (await listen(server, 0, '127.0.0.1')).port;
  const catalog = buildCatalog({ summary: 'Notion', children: [notionNode(`http://127.0.0.1:${port}/mcp`)] }).catalog;
  grant = await computeGrant(
    catalog,
    { allows: () => true, actions: ['describe'] },
    {
      caller: { workspaceId: stand.workspaceId, threadId: stand.mainThreadId, agentName: 'designer' },
      connections,
    },
  );
});

after(async () => {
  await closeServer(server);
  await stand.stop();
});

beforeEach(() => {
  opened = [];
  ended = [];
  toolsCalled = [];
  tokens = [];
  deleteStatus = 200;
  rejectToken = null;
  result = {};
  hasAccount = true;
});
function answer(data: unknown) {
  result = { content: [{ type: 'text', text: JSON.stringify(data) }] };
}
function call(name: string, input: JsonObject) {
  return invokeCapability(grant, 'notion_' + name, { ...input, account: 'work' }, { connections });
}

test('only general and designer get Notion, and the node needs an account', async () => {
  const agents = await import('../capabilities/agent-catalog.ts');
  const { coordinator } = await import('../../agents/access.ts');
  agents.loadAgents();
  const recipients = [];
  for (const agent of [coordinator, ...agents.getAgents()]) {
    const access = await computeGrant(grant.catalog, agents.agentGrantPolicy(agent, ['describe']), {
      caller: grant.caller,
      connections,
    });
    if (access.vertices.has('notion_fetch')) recipients.push(agent.name);
  }
  assert.deepEqual(recipients.sort(), ['architect', 'codex', 'designer', 'engineer', 'manager']);
  const view = await describe(grant, { name: 'notion' }, { connections });
  assert.ok(view.kind === 'node');
  assert.deepEqual(view.accounts, [account]);
  hasAccount = false;
  assert.equal(
    (
      await computeGrant(
        grant.catalog,
        { allows: () => true, actions: ['describe'] },
        { caller: grant.caller, connections },
      )
    ).vertices.has('notion'),
    false,
  );
  await assert.rejects(call('fetch', { id: 'x' }), { kind: 'not_found' });
  assert.deepEqual(opened, []);
});

test('a 401 retries with the rejected token, ends both sessions and journals the actual value once', async () => {
  const { dispatchCatalogCall } = await import('./call-journal.ts');
  const { prisma } = await import('../db/client.ts');
  const page = { title: 'Notes', metadata: { type: 'page' }, text: '# Notes', url: 'https://notion.test/p' };
  answer({ ...page, metadata: { ...page.metadata, version: 2 }, truncated: true, unknown_block_ids: ['child'] });
  rejectToken = 'Bearer first';
  const input = { id: 'p', account: 'work' };
  const value = { ...page, attributes: { truncated: true, unknown_block_ids: ['child'] } };
  const callId = 'notion-fetch-1';
  const outcome = await dispatchCatalogCall(grant, connections, { callId, name: 'notion_fetch', input });
  assert.ok('value' in outcome);
  assert.deepEqual(outcome.value, value);
  assert.deepEqual(tokens, [undefined, 'first']);
  assert.deepEqual(
    toolsCalled,
    ['Bearer first', 'Bearer fresh'].map(token => ({ token, tool: 'notion-fetch', input: { id: 'p' } })),
  );
  assert.deepEqual(ended, ['session-1', 'session-2']);
  const rows = await prisma.event.findMany({
    where: { payload: { path: ['callId'], equals: callId } },
    orderBy: { seq: 'asc' },
  });
  assert.deepEqual(
    rows.map(r => r.payload),
    [
      { callId, functionName: 'notion_fetch', input },
      { callId, functionName: 'notion_fetch', value },
    ],
  );
});

test('search retains plan notices and private pages normalize the final cursor', async () => {
  const item = { title: 'P', url: 'url', type: 'page' };
  answer({ type: 'workspace_search', results: [{ ...item, id: 'p', path: '/p' }], notices: ['title_only ignored'] });
  assert.deepEqual(await call('search', { query: 'P', filters: { title_only: true } }), {
    type: 'workspace_search',
    results: [{ ...item, id: 'p', timestamp: null, highlight: null, attributes: { path: '/p' } }],
    notices: ['title_only ignored'],
  });
  const users = { type: 'user_search', results: [{ text: 'No matches' }] };
  answer(users);
  assert.deepEqual(await call('search', { query: 'name', query_type: 'user' }), { ...users, notices: [] });
  for (const cursor of ['second', null]) {
    answer({ results: [{ ...item, extra: true }], ...(cursor ? { nextCursor: cursor } : {}) });
    assert.deepEqual(await call('list_private_pages', cursor ? { limit: 1 } : { cursor: 'second' }), {
      results: [item],
      nextCursor: cursor,
    });
  }
  assert.deepEqual(ended, opened);
});

test('create and update request synchronous writes, preserve edit warnings and distinguish a queued update', async () => {
  const pages = [{ id: 'p', url: 'url', properties: { title: 'P' } }];
  answer({ pages: pages.map(page => ({ ...page, extra: true })) });
  const draft = { pages: [{ properties: { title: 'P' } }], creation_mode: 'draft' };
  await assert.rejects(call('create_pages', { ...draft, parent: { page_id: 'p' } }), { kind: 'invalid_input' });
  assert.deepEqual(await call('create_pages', draft), { pages });
  assert.deepEqual(toolsCalled[0], {
    token: 'Bearer first',
    tool: 'notion-create-pages',
    input: { ...draft, allow_async: false },
  });
  const edit = { page_id: 'p', command: 'update_content', content_updates: [{ old_str: 'before', new_str: 'after' }] };
  answer({ page_id: 'p', warnings: ['One match skipped'] });
  assert.deepEqual(await call('update_page', edit), { pageId: 'p', warnings: ['One match skipped'], asyncTask: null });
  assert.deepEqual(toolsCalled[1]?.input, { ...edit, allow_async: false });
  const task = { type: 'async_task', id: 't' };
  answer(task);
  assert.deepEqual(await call('update_page', edit), { pageId: null, warnings: [], asyncTask: task });
});

test('a malformed create result keeps the provider IDs in the error and the journal after a single write', async () => {
  const { dispatchCatalogCall } = await import('./call-journal.ts');
  const { prisma } = await import('../db/client.ts');
  const data = { pages: [{ id: 'created', url: 'url' }] };
  answer(data);
  const callId = 'malformed-notion-create';
  const name = 'notion_create_pages';
  const input = { pages: [{ content: 'Test' }], creation_mode: 'draft', account: 'work' };
  const outcome = await dispatchCatalogCall(grant, connections, { callId, name, input });
  assert.ok('error' in outcome);
  assert.equal(outcome.error.kind, 'external_error');
  assert.match(outcome.error.message, /pages\.0\.properties/);
  assert.deepEqual(outcome.error.details, data);
  const event = await prisma.event.findUniqueOrThrow({ where: { seq: outcome.seq } });
  assert.equal(event.type, 'tool.call.failed');
  assert.deepEqual(event.payload, { callId, functionName: name, error: outcome.error });
  assert.equal(toolsCalled.length, 1);
});

test('a second 401 needs sign-in, a malformed answer or tool refusal is external, a failed DELETE never replays a write', async () => {
  rejectToken = '*';
  await assert.rejects(call('fetch', { id: 'p' }), { kind: 'auth_required' });
  assert.equal(toolsCalled.length, 2);
  rejectToken = null;
  result = { content: [{ type: 'text', text: 'invalid JSON' }] };
  await assert.rejects(call('fetch', { id: 'p' }), { kind: 'external_error' });
  answer({ text: 'missing fields' });
  await assert.rejects(call('fetch', { id: 'p' }), { kind: 'external_error' });
  result = { isError: true, content: [{ type: 'text', text: 'protected child page' }] };
  await assert.rejects(call('update_page', { page_id: 'p', command: 'replace_content', new_str: 'body' }), {
    kind: 'external_error',
    message: /protected child page/,
  });
  answer({ page_id: null });
  await assert.rejects(call('update_page', { page_id: 'p', command: 'update_properties', icon: 'none' }), {
    kind: 'external_error',
    message: /check whether the change took effect/i,
    details: { page_id: null },
  });
  deleteStatus = 401;
  answer({ page_id: 'p' });
  assert.deepEqual(await call('update_page', { page_id: 'p', command: 'update_properties', icon: 'none' }), {
    pageId: 'p',
    warnings: [],
    asyncTask: null,
  });
  assert.equal(toolsCalled.length, 7);
  assert.deepEqual(ended, opened);
});
