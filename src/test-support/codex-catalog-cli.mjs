#!/usr/bin/env node
// Scenario at the CLI boundary. The real Codex SDK starts this executable
// with its config and resume argument; the MCP client uses the supplied URL.
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

function config(name) {
  const arg = process.argv.find(value => value.startsWith(name + '='));
  return JSON.parse(arg.slice(name.length + 1));
}

const emit = event => console.log(JSON.stringify(event));
const id = 'codex-catalog-test-session';
const resumed = process.argv.includes('resume');
if (resumed) assert.ok(process.argv.includes(id));
let input = '';
for await (const chunk of process.stdin) input += chunk;
emit({ type: 'thread.started', thread_id: id });
emit({ type: 'turn.started' });
const instructions = config('developer_instructions');
assert.match(instructions, /tools\.mcp__balabash__describe/);
assert.doesNotMatch(instructions, /workspace_export_file|workspace_import_file|remote_fetch_file|send_images/);
const client = new Client({ name: 'codex-scenario', version: '1' });
await client.connect(new StreamableHTTPClientTransport(new URL(config('mcp_servers.balabash.url'))));
const { tools } = await client.listTools();
const names = tools.map(t => t.name);
assert.ok(!names.includes('send_file') && !names.includes('call'));
const call = (name, args) => client.callTool({ name, arguments: args });
async function success(name, args) {
  const result = await call(name, args);
  assert.ok(!result.isError, JSON.stringify(result.content));
  return result.structuredContent;
}
let text;
if (config('features.image_generation')) {
  assert.ok(!names.includes('send_images') && !names.includes('projects_list'));
  const { value: file } = await success('export_file', { path: 'poster.png' });
  assert.equal(file.name, 'poster.png');
  assert.deepEqual(await success('send_message', { files: [file.id] }), { value: null });
  await success('end_thread', { title: 'Generated poster', description: 'A poster', summary: 'Delivered', files: [file.id] });
  text = 'Goodbye';
} else if (resumed) {
  assert.match(input, /Reply from child thread/);
  assert.ok(names.includes('gmail_search_emails'));
  assert.match(instructions, /node gmail —/);
  const account = await success('describe', { name: 'gmail' });
  assert.equal(account.value.accounts[0].account, 'work');
  assert.deepEqual(await success('end_thread', { title: 'Catalog exercised', description: 'Two turns', summary: 'Finished' }), { value: null });
  text = 'Finished';
} else {
  assert.doesNotMatch(instructions, /node gmail —/);
  assert.ok(!names.includes('gmail_search_emails'));
  const list = tools.find(t => t.name === 'projects_list');
  assert.equal(list.outputSchema.properties.value.properties.projects.items.type, 'object');
  const opened = await success('describe', { name: 'projects_list' });
  assert.ok(opened.guide.length && opened.value.signature.includes('Project'));
  assert.equal((await success('describe', { name: 'projects_get' })).guide, undefined);
  assert.deepEqual(await success('projects_list', {}), { value: { projects: [] } });
  const invalid = await call('projects_get', { slug: 12 });
  assert.ok(invalid.isError);
  assert.equal(JSON.parse(invalid.content[0].text).kind, 'invalid_input');
  const denied = await call('gmail_search_emails', {});
  assert.ok(denied.isError);
  assert.deepEqual(await success('run_program', { code: "return (await call('projects_list', {})).projects.length" }), { value: 0 });
  const child = await success('spawn_agent', { agent: 'browser', title: 'Probe', prompt: 'Probe' });
  text = child.value.threadId;
}
await client.close();
emit({ type: 'item.completed', item: { type: 'agent_message', id: 'message', text } });
emit({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } });
