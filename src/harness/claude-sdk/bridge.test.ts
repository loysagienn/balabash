import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { sessionInputs } from './session.ts';
import { startStand } from '../../test-support/stand.ts';

test('the Claude input stream shares the opening grant and refreshes queued messages in order', async () => {
  async function* queued() {
    yield 'spawn';
    yield 'user message';
    yield 'child reply';
  }
  const refreshed: string[] = [];
  const sent: unknown[] = [];
  for await (const input of sessionInputs(queued(), async text => {
    refreshed.push(text);
    return 'checked: ' + text;
  })) {
    sent.push(input.message.content);
  }
  assert.deepEqual(refreshed, ['user message', 'child reply']);
  assert.deepEqual(sent, ['spawn', 'checked: user message', 'checked: child reply']);
});

// Exercise the SDK's MCP instance over a real protocol connection, and feed
// its wire results to the same hook module the CLI loads in the plugin.
test('Claude opens granted leaves, refreshes its list and journals the catalog value', async t => {
  const stand = await startStand();
  t.after(() => stand.stop());
  const { agent } = await import('../../../agents/engineer.ts');
  (await import('../../capabilities/agent-catalog.ts')).loadAgents();
  await (await import('../../tree/index.ts')).startTree();
  const { createClaudeBridge, createClaudePort } = await import('./bridge.ts');
  const { prisma } = await import('../../db/client.ts');
  const { workspaceId, mainThreadId } = stand;
  const { id: threadId } = await (await import('../../core/threads.ts')).startThread({
    workspaceId, parentThreadId: mainThreadId, agent: agent.name, headless: false, actor: 'system',
  });
  const passport = { ...agent, get access() { return agent.access; } };
  const bridge = await createClaudeBridge(passport, workspaceId, threadId);
  const client = new Client({ name: 'claude-port-test', version: '1' });
  const [local, remote] = InMemoryTransport.createLinkedPair();
  await bridge.server.connect(local);
  await client.connect(remote);
  t.after(() => client.close());
  const list = async () => (await client.listTools()).tools;
  const initial = await list();
  assert.deepEqual(initial.filter(tool => tool._meta?.['anthropic/alwaysLoad']).map(tool => tool.name), ['describe', 'run_program']);
  assert.ok(!initial.some(tool => tool.name === 'gmail_send_email'));
  assert.match(bridge.instructions, /ToolSearch/);
  assert.doesNotMatch(bridge.instructions, /node gmail —/);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    return { text: (result.content as { text: string }[])[0].text, isError: result.isError };
  };
  assert.equal(await bridge.refresh('same grant'), 'same grant');
  bridge.onCompact();
  assert.equal(await bridge.refresh('same system catalog'), 'same system catalog');
  const changed = Promise.withResolvers<void>();
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => { changed.resolve(); });
  await prisma.connection.create({ data: { workspaceId, server: 'gmail', accountKey: 'work', displayName: 'Work', status: 'pending' } });
  // Fail one grant lookup before the new port exists.
  t.mock.getter(passport, 'access', () => { throw new Error('lookup failed'); }, { times: 1 });
  assert.equal(await bridge.refresh('during lookup failure'), 'during lookup failure');
  assert.ok(!(await list()).some(tool => tool.name === 'gmail_send_email'));
  assert.match(await bridge.refresh('next input'), /node gmail —[\s\S]+next input$/);
  await changed.promise;
  bridge.onCompact();
  assert.match(await bridge.refresh('after compact'), /node gmail —[\s\S]+after compact$/);
  assert.equal(await bridge.refresh('next'), 'next');
  assert.ok((await list()).some(tool => tool.name === 'gmail_send_email'));

  await prisma.connection.create({ data: { workspaceId, server: 'gmail', accountKey: 'home', displayName: 'Home', status: 'pending' } });
  assert.equal(await bridge.refresh('another account'), 'another account');
  const name = 'gmail_send_email';
  const samplePort = await createClaudePort(passport, workspaceId, threadId);
  const beforeSamples = await prisma.event.count();
  const samples = await Array.fromAsync(samplePort.sampleOpenings());
  assert.equal(await prisma.event.count(), beforeSamples);
  const leaf = await call('describe', { name });
  assert.deepEqual(samples.find(sample => sample.name === name)?.result, JSON.parse(leaf.text));
  const value = JSON.parse(leaf.text);
  assert.equal(value.parent, 'gmail');
  assert.deepEqual(value.accounts.map((a: { account: string }) => a.account).sort(), ['home', 'work']);
  assert.ok(value.rules && value.returns && value.signature && value.guide.length);
  const handlers = new Map<string, Function>();
  const plugin = new URL('../../../plugins/catalog/hooks/register.js', import.meta.url);
  const { register } = await import(plugin.href);
  register((event: string, selector: Function | { tool: string }, hook?: Function) => {
    handlers.set(typeof selector === 'function' ? event : selector.tool, typeof selector === 'function' ? selector : hook!);
  });
  const describe = handlers.get('mcp__balabash__describe')!;
  const node = await call('describe', { name: 'gmail' });
  assert.equal(await describe({}, { agentId: 'from-node' }, () => node), node);
  const open = (agentId: string) => describe({}, { agentId }, () => leaf);
  assert.ok(!(await open('from-node')).context[0].includes(value.guide[0]));
  const first = await open('main');
  assert.deepEqual(first.result, [{ type: 'tool_reference', tool_name: 'mcp__balabash__gmail_send_email' }]);
  assert.ok(first.context[0].includes(value.guide[0]) && first.context[0].includes('Accounts:'));
  assert.ok(!(await open('main')).context[0].includes(value.guide[0]));
  assert.ok((await open('child')).context[0].includes(value.guide[0]));
  await handlers.get('session.compact')!({}, {}, () => ({}));
  const search = await handlers.get('ToolSearch')!({ mcp: { call: async () => {
    const result = await describe({}, {}, Object.assign(() => leaf, { origin: { plugin: 'balabash-catalog' } }));
    assert.equal(result, leaf);
    return { content: [{ type: 'text', text: result.text }] };
  } } }, { agentId: 'main' }, () => ({ result: { matches: ['Read', 'mcp__balabash__gmail_send_email'] } }));
  assert.ok(search.context[0].includes(value.guide[0]));
  const delta = await handlers.get('prompt.attachment')!({}, { type: 'deferred_tools_delta' }, () => ({
    text: 'Deferred tools:\nRead\nmcp__balabash__gmail_send_email\nmcp__environment__browser_navigate',
  }));
  assert.equal(delta.text, 'Deferred tools:\nRead\nmcp__environment__browser_navigate');

  await prisma.connection.deleteMany({ where: { workspaceId, server: 'gmail' } });
  const notice = t.mock.method(bridge.server.server, 'sendToolListChanged');
  notice.mock.mockImplementationOnce(async () => { throw new Error('notification failed'); });
  const removed = await bridge.refresh('removed');
  assert.match(removed, /replaces the catalog section[\s\S]+removed$/);
  assert.doesNotMatch(removed, /node gmail —/);
  assert.ok(!(await list()).some(tool => tool.name === name));
  assert.equal((await call(name, {})).isError, true);
  assert.equal(await bridge.refresh('retry notification'), 'retry notification');
  assert.equal(notice.mock.callCount(), 2);
  bridge.onCompact();
  assert.equal(await bridge.refresh('back to system catalog'), 'back to system catalog');
  const refusal = await call('projects_get', { slug: 123 });
  assert.equal(JSON.parse(refusal.text).kind, 'invalid_input');
  const program = await call('run_program', { code: 'return (await call("projects_list", {})).projects.length;' });
  assert.equal(program.text, '0');

  const rows = await prisma.event.findMany({ where: { threadId, type: { startsWith: 'tool.call.' } }, orderBy: { seq: 'asc' } });
  const events = rows.map(row => ({ type: row.type, data: row.payload as Record<string, any> }));
  const starts = events.filter(row => row.type === 'tool.call.started');
  assert.equal(new Set(starts.map(row => row.data.callId)).size, starts.length);
  for (const { data } of starts) assert.equal(events.filter(row => row.data.callId === data.callId).length, 2);
  assert.equal(events.find(row => row.data.value?.kind === 'capability')!.data.value.parent, undefined);
  assert.equal(events.find(row => row.type === 'tool.call.failed' && row.data.functionName === 'projects_get')!.data.error.kind, 'invalid_input');
  assert.ok(starts.some(row => row.data.functionName === 'projects_list' && row.data.runId === starts.find(row => row.data.functionName === 'run_program')!.data.callId));
});
