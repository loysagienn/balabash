import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { startStand } from '../test-support/stand.ts';

test('a connector discovers paged contracts, grants by recipient, journals calls and recovers on CLI rotation', async t => {
  const stand = await startStand();
  t.after(() => stand.stop());
  const { startTree } = await import('./index.ts');
  const { catalogContext, catalogInstructions, grantKey } = await import('../harness/catalog-context.ts');
  const { createCodexPort } = await import('../harness/codex-sdk/catalog-bridge.ts');
  const { dispatchCatalogCall } = await import('./call-journal.ts');
  const { coordinator } = await import('../../agents/access.ts');
  const { prisma } = await import('../db/client.ts');
  const { connectorServiceViews } = await import('./connectors.ts');
  const schema = { type: 'object' as const, properties: { channel_id: { type: 'string' } }, required: ['channel_id'], additionalProperties: false };
  const typed: Tool = { name: 'send-message', description: 'Send a message.', inputSchema: schema,
    outputSchema: { type: 'object', properties: { ts: { $ref: '#/$defs/ID' } }, $defs: { ID: { type: 'string' } }, required: ['ts'] } };
  const free: Tool = { name: 'search', description: 'Search messages.', inputSchema: { type: 'object' } };
  const requests: { method: string; token: string; session: string; name?: string }[] = [];
  let reply: CallToolResult = { structuredContent: { ts: 'posted', extra: true }, content: [] };
  let refused = false;
  let delayNextCall = false;
  const delayedCallStarted = Promise.withResolvers<void>();
  const delayedResponse = Promise.withResolvers<Response>();
  const old = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  t.after(() => { if (old === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN; else process.env.CLAUDE_CODE_OAUTH_TOKEN = old; });
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-first';
  const fetchOriginal = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url: URL, init: RequestInit) => {
    if (String(url) !== 'https://mcp-proxy.anthropic.com/v1/mcp/mcpsrv_123') return fetchOriginal(url, init);
    const headers = new Headers(init.headers);
    const session = headers.get('x-mcp-client-session-id')!;
    assert.ok(session);
    assert.equal(headers.get('anthropic-beta'), 'mcp-servers-2025-12-04');
    if (init.method === 'DELETE' || init.method === 'GET') return new Response(null, { status: 405 });
    const { id, method, params } = JSON.parse(String(init.body));
    requests.push({ method, token: headers.get('authorization')!, session, name: params?.name });
    if (delayNextCall && method === 'tools/call') {
      delayNextCall = false;
      delayedCallStarted.resolve();
      return delayedResponse.promise;
    }
    if (refused && method === 'tools/call') return Response.json({ error: { message: 'token rejected' } }, { status: 401 });
    if (method === 'notifications/initialized') return new Response(null, { status: 202 });
    const result = method === 'initialize'
      ? { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'mock', version: '1' } }
      : method === 'tools/list' ? (params.cursor ? { tools: [free] } : { tools: [typed], nextCursor: 'next' }) : reply;
    return Response.json({ jsonrpc: '2.0', id, result }, { headers: { 'mcp-session-id': session } });
  });

  await fs.mkdir('data/mcp-servers', { recursive: true });
  await fs.writeFile('data/mcp-servers/slack.json', JSON.stringify({
    transport: 'claude-connector', serverId: 'mcpsrv_123', description: 'Search and send Slack messages.', recipients: ['general'],
  }));
  await startTree();
  const agent = { ...coordinator, access: { profile: 'general' } };
  const context = () => catalogContext(agent, stand.workspaceId, stand.mainThreadId);
  const first = await context();
  const other = await catalogContext(coordinator, stand.workspaceId, stand.mainThreadId);
  assert.equal(other.grant.vertices.has('slack'), false);
  assert.ok(first.grant.vertices.has('slack_send_message'));
  assert.doesNotMatch(catalogInstructions(first.grant, ''), /send_message — Send a message\.|channel_id/);
  const port = await createCodexPort(agent, stand.workspaceId, stand.mainThreadId);
  const published = port.tools.find(tool => tool.name === 'slack_send_message')!;
  assert.equal(JSON.stringify(published.outputSchema).includes('#/properties/value/$defs/ID'), true);
  assert.deepEqual(published.inputSchema, schema);
  const call = async (name: string, input: Record<string, string> = {}) => dispatchCatalogCall(first.grant, first.connections,
    { callId: crypto.randomUUID(), name, input });
  const send = () => call('slack_send_message', { channel_id: 'c' });
  const invalid = await call('slack_send_message');
  assert.equal('error' in invalid && invalid.error.kind, 'invalid_input');
  assert.equal(requests.filter(r => r.method === 'tools/call').length, 0);
  const posted = await send();
  assert.deepEqual('value' in posted && posted.value, { ts: 'posted', extra: true });
  const row = await prisma.event.findUniqueOrThrow({ where: { seq: posted.seq } });
  assert.equal(row.type, 'tool.call.completed');
  assert.deepEqual((row.payload as Record<string, unknown>).value, { ts: 'posted', extra: true });
  reply = { content: [{ type: 'text', text: 'accepted despite malformed result' }] };
  const malformed = await send();
  assert.ok('error' in malformed);
  assert.equal(malformed.error.kind, 'external_error');
  assert.equal(malformed.error.details, 'accepted despite malformed result');
  reply = { content: [{ type: 'text', text: 'message' }, { type: 'image', data: 'eA==', mimeType: 'image/png' }] };
  const mixed = await call('slack_search');
  assert.ok('value' in mixed && Array.isArray(mixed.value));
  assert.equal(mixed.value[0], 'message');
  assert.equal((mixed.value[1] as { kind: string }).kind, 'file');
  assert.doesNotMatch(JSON.stringify(mixed.value), /eA==/);
  assert.equal(requests.filter(r => r.method === 'tools/list').length, 2);

  delayNextCall = true;
  const inFlight = send();
  await delayedCallStarted.promise;
  refused = true;
  const denied = await send();
  assert.ok('error' in denied);
  assert.equal(denied.error.kind, 'auth_required');
  assert.match(denied.error.message, /CLAUDE_CODE_OAUTH_TOKEN/);
  assert.equal(requests.filter(r => r.name === 'send-message').length, 4);
  assert.equal((await connectorServiceViews())[0].state, 'failed');
  assert.equal((await context()).grant.vertices.has('slack'), false);
  refused = false;
  typed.description = 'Send a message to a channel.';
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-rotated';
  const recovered = await context();
  assert.ok(recovered.grant.vertices.has('slack_send_message'));
  assert.notEqual(grantKey(first.grant), grantKey(recovered.grant));
  assert.equal((await connectorServiceViews())[0].state, 'connected');
  assert.equal(requests.at(-1)?.token, 'Bearer test-rotated');
  delayedResponse.resolve(Response.json({ error: { message: 'old token rejected' } }, { status: 401 }));
  const late = await inFlight;
  assert.equal('error' in late && late.error.kind, 'auth_required');
  assert.equal((await connectorServiceViews())[0].state, 'connected');
  assert.ok((await context()).grant.vertices.has('slack'));
  assert.equal(requests.filter(r => r.name === 'send-message').length, 4);
  // Substitute only the CLI store; never read credentials from the test host.
  const credentialsFile = path.join(homedir(), '.claude', '.credentials.json');
  let expiresAt = Date.now() - 1000;
  const readFile = fs.readFile.bind(fs);
  const fakeStore = t.mock.method(fs, 'readFile', async (...args: Parameters<typeof readFile>) =>
    args[0] === credentialsFile
      ? JSON.stringify({ claudeAiOauth: { accessToken: 'test-file', expiresAt } }) : readFile(...args));
  syncBuiltinESMExports();
  t.after(() => { fakeStore.mock.restore(); syncBuiltinESMExports(); });
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const beforeExpiry = requests.length;
  const expired = await stand.request('GET', '/api/installation-services');
  assert.equal(expired.status, 200);
  assert.deepEqual(expired.json<{ connectors: object[] }>().connectors[0], {
    name: 'slack', description: 'Search and send Slack messages.', recipients: ['general'],
    state: 'token_expired', error: null, tokenExpiresAt: new Date(expiresAt),
  });
  assert.equal((await context()).grant.vertices.has('slack'), false);
  assert.equal(requests.length, beforeExpiry);
  expiresAt = Date.now() + 60_000;
  assert.ok((await context()).grant.vertices.has('slack'));
  assert.equal(requests.at(-1)?.token, 'Bearer test-file');
});
