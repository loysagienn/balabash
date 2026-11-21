import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import { test } from 'node:test';
import type { SnapshotResponse } from '../api/contract.ts';
import { closeServer, listen, startStand } from '../test-support/stand.ts';

test('configured MCP servers publish the contract discovered with the authority of the installation or workspace', async t => {
  const stand = await startStand();
  t.after(() => stand.stop());
  process.env.MAIN_OPENAI_MODEL = 'fixture';
  t.after(() => { delete process.env.MAIN_OPENAI_MODEL; });
  const { prisma } = await import('../db/client.ts');
  const { catalogContext, grantKey } = await import('../harness/catalog-context.ts');
  const { dispatchCatalogCall } = await import('./call-journal.ts');
  const { getAccountService, getSecretService, refreshSecretServices } = await import('../capabilities/connections/services.ts');
  const { coordinator } = await import('../../agents/access.ts');
  const { startTree, installationNamesFor } = await import('./index.ts');
  const { journalExtensionFailure } = await import('../runtime/extension-journal.ts');
  const recipients = [coordinator.name];
  const { workspaceId, mainThreadId } = stand;
  const foreign = (await prisma.workspace.create({ data: {} })).id;
  const inputSchema = { type: 'object', properties: {}, additionalProperties: false };
  const common = { name: 'read', inputSchema };
  const logs: { path: string; key?: string; method: string; args?: object }[] = [];
  const { handleOauthCallback, disconnectConnection, markReauthorizationRequired } = await import('../capabilities/connections/index.ts');
  let failingToken: string | null = null;
  let refuse = false;
  const server = http.createServer(async (req, res) => {
    const path = req.url!;
    const key = req.headers.authorization;
    if (path.startsWith('/.well-known/oauth-authorization-server')) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        issuer: url, authorization_endpoint: url + '/authorize', token_endpoint: url + '/token',
        response_types_supported: ['code'], code_challenge_methods_supported: ['S256'],
      }));
      return;
    }
    if (path === '/token') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ access_token: 'A', token_type: 'bearer' }));
      return;
    }
    if (req.method !== 'POST') {
      logs.push({ path, key, method: req.method! });
      res.writeHead(req.method === 'DELETE' ? 200 : 405).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const { id, method, params } = JSON.parse(Buffer.concat(chunks).toString());
    logs.push({ path, key, method, args: params?.arguments });
    if (method === 'notifications/initialized') {
      res.writeHead(202).end();
      return;
    }
    if (path === '/wiki' && method === 'tools/list' && key === failingToken) {
      res.writeHead(500).end('Discovery failed, request ' + logs.length);
      return;
    }
    if (refuse && path === '/search') {
      res.writeHead(401).end('Rejected ' + key);
      return;
    }
    res.setHeader('content-type', 'application/json');
    let result;
    if (method === 'initialize') {
      res.setHeader('mcp-session-id', 'test-session');
      result = { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'demo', version: '1' } };
    } else if (method === 'tools/list') {
      result = params.cursor ? { tools: [{ name: key === 'Bearer A' ? 'edit' : 'lookup', inputSchema }] }
        : { tools: path === '/wiki' ? [{
          ...common, description: 'Read as ' + key?.slice(-1), title: 'Read for ' + key?.slice(-1),
        }, {
          name: 'conflict', inputSchema: { ...inputSchema, properties: { account: { type: 'string' } } },
        }] : [common], ...(path === '/wiki' && { nextCursor: 'more' }) };
    } else {
      result = { content: [{ type: 'text', text: 'done' }] };
    }
    res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
  });
  const url = `http://127.0.0.1:${(await listen(server, 0, '127.0.0.1')).port}`;
  t.after(() => closeServer(server));
  await fs.mkdir('data/mcp-servers', { recursive: true });
  const config = (name: string, fields: object) => fs.writeFile(`data/mcp-servers/${name}.json`, JSON.stringify(fields));
  await config('search', { transport: 'http', url: url + '/search', headers: { Authorization: 'Bearer ${secret:KEY}' }, recipients });
  await config('wiki', { transport: 'http', url: url + '/wiki', auth: 'user', description: 'Read documents', recipients });
  await config('legacy', { transport: 'http', url: url + '/search', enabledTools: ['read'] });
  await prisma.externalServerSecret.create({ data: { server: 'broken', key: 'TOKEN', value: 'private-marker' } });
  await config('broken', {
    transport: 'stdio', command: process.execPath, args: ['-e', 'console.error("Missing module", process.env.TOKEN, Date.now());process.exit(1)'],
    env: { TOKEN: '${secret:TOKEN}' },
  });
  await config('invalid', { transport: 'stdio', command: 'node', recipients: 'mistake' });
  await config('missing', { transport: 'stdio', command: './missing-fixture-server' });
  await config('gmail', { transport: 'http', url: url + '/collision', auth: 'user', description: 'Shadow' });
  await fs.writeFile('fixture.cjs', `
    require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
      const { id, method, params } = JSON.parse(line);
      if (id === undefined) return;
      if (method === 'tools/call' && require('node:fs').existsSync('fail-call')) process.exit(1);
      const result = method === 'initialize'
        ? { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'stdio', version: '1' } }
        : method === 'tools/list' ? { tools: [{ name: 'read', inputSchema: { type: 'object' } }] }
        : { content: [{ type: 'text', text: process.env.FIXTURE }] };
      console.log(JSON.stringify({ jsonrpc: '2.0', id, result }));
    });
  `);
  await config('local', { transport: 'stdio', command: process.execPath, args: ['fixture.cjs'], env: { FIXTURE: 'ready' }, recipients });
  await startTree(journalExtensionFailure);
  const context = (ws = workspaceId) => catalogContext(coordinator, ws, mainThreadId);
  const call = async (ctx: Awaited<ReturnType<typeof context>>, name: string, input = {}) =>
    dispatchCatalogCall(ctx.grant, ctx.connections, { name, input, callId: crypto.randomUUID() });

  await t.test('cards and System include cold configuration and discovery failures', async () => {
    assert.deepEqual(installationNamesFor(coordinator), ['local', 'search', 'wiki']);
    assert.equal(getAccountService('wiki')?.url, url + '/wiki');
    assert.notEqual(getAccountService('gmail')?.url, url + '/collision');
    const snapshot = await stand.request('GET', '/api/snapshot');
    assert.equal(snapshot.status, 200);
    const { systemLog } = snapshot.json<SnapshotResponse>();
    const errors = systemLog.filter(row => row.payload.scope === 'mcp-servers').map(row => row.payload.error).join('\n');
    assert.match(errors, /gmail.json.*already belongs/);
    assert.match(errors, /invalid.json.*recipients/);
    assert.match(errors, /missing.json.*ENOENT/);
    assert.match(errors, /legacy.json.*enabledTools/);
    assert.match(errors, /broken.json[\s\S]*stderr: Missing module \[redacted\]/);
    assert.doesNotMatch(errors, /private-marker/);
    assert.equal(getSecretService('search')?.connected, false);
    const ctx = await context();
    assert.ok(!ctx.grant.vertices.has('wiki'));
    assert.ok(!ctx.grant.vertices.has('search'));
    const stdio = await call(ctx, 'local_read');
    assert.equal('value' in stdio && stdio.value, 'ready');
  });

  await t.test('a failed call stays in its own journal; discovery reports once per outage', async sub => {
    const mcpErrors = () => prisma.event.count({ where: {
      type: 'system.exception', payload: { path: ['scope'], equals: 'mcp-servers' },
    } });
    const before = await mcpErrors();
    await fs.writeFile('fail-call', '');
    const failed = await call(await context(), 'local_read');
    assert.ok('error' in failed && failed.error.kind === 'unavailable');
    assert.equal((await prisma.event.findUniqueOrThrow({ where: { seq: failed.seq } })).type, 'tool.call.failed');
    assert.equal(await mcpErrors(), before);
    await fs.unlink('fail-call');
    const now = Date.now() + 61_000;
    sub.mock.method(Date, 'now', () => now);
    await refreshSecretServices();
    assert.equal(await mcpErrors(), before, 'new diagnostic timestamp belongs to the same discovery outage');
  });

  await t.test('one probe publishes the secret-backed node and an old grant reads the current key', async () => {
    const key = { server: 'search', key: 'KEY' };
    await prisma.externalServerSecret.create({ data: { ...key, value: 'first-key' } });
    await Promise.all([refreshSecretServices(), refreshSecretServices()]);
    assert.equal(getSecretService('search')?.connected, true);
    const first = await context();
    assert.ok(first.grant.vertices.has('search_read'));
    assert.deepEqual(logs.filter(r => r.path === '/search' && r.method === 'tools/list').map(r => r.key), ['Bearer first-key']);
    assert.equal(logs.filter(r => r.path === '/search' && r.method === 'DELETE').length, 1);
    await prisma.externalServerSecret.update({ where: { server_key: key }, data: { value: 'next-key' } });
    await refreshSecretServices();
    assert.equal(grantKey(first.grant), grantKey((await context()).grant));
    assert.ok('value' in await call(first, 'search_read'));
    assert.equal(logs.findLast(r => r.method === 'tools/call')?.key, 'Bearer next-key');
    refuse = true;
    const denied = await call(first, 'search_read');
    assert.ok('error' in denied && denied.error.kind === 'auth_required');
    assert.doesNotMatch(getSecretService('search')!.error!, /next-key/);
    assert.equal(getSecretService('search')?.connected, false);
    const { forgetExternalServerSecrets } = await import('../capabilities/external-secrets.ts');
    await forgetExternalServerSecrets('search');
    assert.ok(!(await context()).grant.vertices.has('search'));
    const expired = await call(first, 'search_read');
    assert.ok('error' in expired && expired.error.kind === 'auth_required');
    assert.equal(logs.filter(r => r.path === '/search' && r.method === 'tools/call').length, 1);
  });

  await t.test('OAuth listings are workspace-local; the selected account is checked and stripped before tools/call', async () => {
    const add = (ws: string, account: string, token: string) => prisma.connection.create({ data: {
      workspaceId: ws, server: 'wiki', status: 'connected', accountKey: account, displayName: account, tokens: { access_token: token },
    } });
    await prisma.oauthClient.create({ data: { server: 'wiki', clientInformation: { client_id: 'fixture' } } });
    const work = await prisma.connection.create({ data: {
      workspaceId, server: 'wiki', accountKey: 'work', displayName: 'Work', status: 'pending',
      pendingState: 'wiki-login', pending: { codeVerifier: 'fixture-verifier' },
    } });
    const login = await handleOauthCallback({ state: 'wiki-login', code: 'fixture-code' });
    assert.ok(login.ok, login.error ?? 'OAuth callback failed');
    const afterLogin = await context();
    assert.ok(afterLogin.grant.vertices.has('wiki_read'), 'ready when the callback completes, without a periodic refresh');
    assert.ok(!afterLogin.grant.vertices.has('wiki_conflict'));

    await add(foreign, 'other', 'B');
    await refreshSecretServices();
    const first = await context();
    assert.ok(first.grant.vertices.has('wiki_edit'));
    assert.ok(!first.grant.vertices.has('wiki_lookup'));
    const theirs = await context(foreign);
    assert.ok(theirs.grant.vertices.has('wiki_lookup'));
    assert.ok(!theirs.grant.vertices.has('wiki_edit'));
    const invalid = await call(first, 'wiki_read', { account: 'work', extra: 1 });
    assert.ok('error' in invalid && invalid.error.kind === 'invalid_input');
    const noAccount = await call(first, 'wiki_read');
    assert.ok('error' in noAccount && noAccount.error.kind === 'invalid_input');
    const wrong = await call(first, 'wiki_read', { account: 'other' });
    assert.ok('error' in wrong && wrong.error.kind === 'not_found');
    assert.equal(logs.filter(r => r.path === '/wiki' && r.method === 'tools/call').length, 0);
    failingToken = 'Bearer B';
    const second = await add(workspaceId, 'shared', 'B');
    await refreshSecretServices();
    const partial = await context();
    assert.equal(grantKey(first.grant), grantKey(partial.grant), 'a failed new listing leaves the existing contract usable');
    const stillWorks = await call(partial, 'wiki_edit', { account: 'work' });
    assert.equal('value' in stillWorks && stillWorks.value, 'done');
    const issues = await prisma.event.findMany({ where: { type: 'system.exception', workspaceId } });
    const messages = issues.map(row => JSON.stringify(row.payload)).join('\n');
    assert.match(messages, /Tools omitted.*conflict/);
    await markReauthorizationRequired(second.id, 'Renew sign-in');
    failingToken = null;
    await prisma.connection.update({ where: { id: second.id }, data: { status: 'connected' } });
    await refreshSecretServices();
    const both = await context();
    assert.ok(both.grant.vertices.has('wiki_read'), 'personalized titles and descriptions still share the same call contract');
    assert.ok(!both.grant.vertices.has('wiki_edit') && !both.grant.vertices.has('wiki_lookup'));
    assert.notEqual(grantKey(first.grant), grantKey(both.grant));
    const failures = await prisma.event.findMany({ where: {
      type: 'system.exception', workspaceId, payload: { path: ['error'], string_contains: 'Discovery failed' },
    } });
    assert.equal(failures.length, 1);
    const omissions = await prisma.event.findMany({ where: {
      type: 'system.exception', workspaceId, payload: { path: ['error'], string_contains: 'Tools omitted' },
    } });
    assert.ok(omissions.some(row => /edit, lookup/.test(JSON.stringify(row.payload))));
    const port = await (await import('../harness/codex-sdk/catalog-bridge.ts')).createCodexPort(coordinator, workspaceId, mainThreadId);
    const definition = port.tools.find(tool => tool.name === 'wiki_read')!;
    assert.deepEqual(definition.inputSchema.required, ['account']);
    const read = await call(both, 'wiki_read', { account: 'shared' });
    assert.equal('value' in read && read.value, 'done');
    assert.deepEqual(logs.findLast(r => r.method === 'tools/call'), { path: '/wiki', key: 'Bearer B', method: 'tools/call', args: {} });
    const event = await prisma.event.findUniqueOrThrow({ where: { seq: read.seq } });
    assert.equal(event.type, 'tool.call.completed');
    await disconnectConnection(workspaceId, 'wiki', 'shared');
    assert.equal(grantKey(first.grant), grantKey((await context()).grant));

    const { invokeCapability } = await import('../catalog/index.ts');
    const taskGrant = (await catalogContext({ ...coordinator, access: { nodes: ['schedule'] } }, workspaceId, mainThreadId)).grant;
    const schedule = (name: string, input: object) => invokeCapability(taskGrant, name, input, first);
    await schedule('schedule_create_task', {
      slug: 'wiki-check', name: 'Read wiki', description: 'Check the workspace catalog', kind: 'program',
      code: "return await call('wiki_edit', { account: 'work' });", at: '2031-05-01T09:00:00Z', wake: false,
    });
    const run = await schedule('schedule_run_task', { slug: 'wiki-check' }) as { runId: string };
    const { setTimeout: delay } = await import('node:timers/promises');
    let status = 'running';
    const until = Date.now() + 15_000;
    while (status === 'running' && Date.now() < until) {
      await delay(40);
      status = (await prisma.scheduleRun.findUniqueOrThrow({ where: { id: run.runId } })).status;
    }
    assert.equal(status, 'ok');
    assert.equal((await prisma.scheduleRun.findUniqueOrThrow({ where: { id: run.runId } })).value, 'done');

    await markReauthorizationRequired(work.id, 'Renew sign-in');
    const inactive = await context();
    assert.equal(grantKey(first.grant), grantKey(inactive.grant));
    const denied = await call(inactive, 'wiki_edit', { account: 'work' });
    assert.ok('error' in denied && denied.error.kind === 'auth_required');
  });
});
