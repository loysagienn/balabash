// Exercise the configured stateless port, including the model's second wake.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Response, ResponseCreateParamsNonStreaming } from 'openai/resources/responses/responses';
import { startStand } from '../test-support/stand.ts';

test('compatible Responses opens signatures and journals the actual capability under the wire call id', async t => {
  const stand = await startStand();
  t.after(() => stand.stop());
  process.env.LLM_BACKEND = 'openai-compatible';
  process.env.MAIN_OPENAI_MODEL = 'stand-model';
  const { createCoordinatorRun, hasActiveCoordinatorTurns } = await import('./index.ts');
  const { appendEvent } = await import('../core/append.ts');
  const { getTranscript } = await import('../core/events.ts');
  const { ingestFile } = await import('../files/index.ts');
  const { mainThreadId: threadId, workspaceId } = stand;
  const file = await ingestFile({ workspaceId, body: 'file content only on this turn', contentType: 'text/plain', originalFilename: 'test.txt', scope: 'web' });
  const calls = [
    ['describe', { name: 'projects_list' }],
    ['call', { name: 'projects_list' }],
    ['call', { name: 'view_file', input: { file: file.id } }],
    ['call', { name: 'end_thread' }], // outside the grant
    ['call', { name: 'run_program' }], // an action is not a capability
    ['call', { input: {} }], // malformed envelope
    ['do_nothing', {}],
    ['call', { name: 'projects_list' }],
    ['do_nothing', {}],
  ] as const;
  const requests: ResponseCreateParamsNonStreaming[] = [];
  const run = createCoordinatorRun({ threadId, workspaceId }, {
    client: { responses: { create: async request => {
      const i = requests.length;
      requests.push(request);
      const [name, input] = calls[i]!;
      return { id: 'r' + i, output: [{ type: 'function_call', name, arguments: JSON.stringify(input), call_id: 'c' + i }] } as Response;
    } } },
  });
  async function wake() {
    const result = await appendEvent({ workspaceId, threadId, type: 'user.message', actor: 'user', payload: { text: 'Check projects' } });
    assert.ok(result.written);
    run.accept(result.event);
    await t.waitFor(() => assert.equal(hasActiveCoordinatorTurns(), false), { timeout: 10_000 });
  }
  function output(i: number) {
    const input = requests[i]!.input;
    assert.ok(Array.isArray(input));
    const last = input.at(-1);
    assert.ok(last?.type === 'function_call_output' && typeof last.output === 'string');
    return last.output;
  }
  await wake();
  await wake();
  assert.equal(requests.length, calls.length);
  const head = requests[0]!;
  assert.deepEqual(head.tools?.map(tool => 'name' in tool && tool.name), ['describe', 'call', 'run_program', 'do_nothing']);
  assert.match(head.instructions!, /through `call` by its full name/);
  for (const request of requests) {
    assert.deepEqual(request.tools, head.tools);
    assert.equal(request.previous_response_id, undefined);
    assert.equal(request.prompt_cache_key, undefined);
    assert.equal(request.prompt_cache_options, undefined);
    assert.ok(Array.isArray(request.input) && request.input.every(item => item.type !== 'additional_tools'));
  }
  assert.match(output(1), /Match a conversation to a project/); // guide precedes the signature
  assert.match(output(1), /projects_list\(input:.*Project/s);
  assert.deepEqual(output(8), output(2)); // call again on the second turn
  assert.match(output(3), /file content only on this turn/);
  assert.equal(JSON.parse(output(4)).kind, 'unknown_capability');
  assert.equal(JSON.parse(output(5)).kind, 'invalid_input');
  assert.match(JSON.parse(output(5)).message, /run_program directly/);
  assert.equal(JSON.parse(output(6)).kind, 'invalid_input');
  const nextInput = JSON.stringify(requests[7]!.input);
  assert.doesNotMatch(nextInput, /file content only on this turn/);
  assert.match(nextInput, /most recently worked on/);
  assert.match(nextInput, /type Project =/);
  assert.match(nextInput, /projects_list\(input:/);
  const events = await getTranscript(threadId, { last: 100 });
  const trace = events.filter(event => event.type.startsWith('tool.call.'));
  const entries = (id: string) => trace.filter(event => event.payload.callId === id);
  assert.deepEqual(entries('c1').map(event => [event.type, event.payload.functionName]), [
    ['tool.call.started', 'projects_list'], ['tool.call.completed', 'projects_list'],
  ]);
  assert.deepEqual(entries('c1')[0]!.payload.input, {});
  assert.deepEqual(JSON.parse(output(2)), entries('c1')[1]!.payload.value);
  assert.deepEqual(entries('c2')[0]!.payload.input, { file: file.id });
  assert.doesNotMatch(JSON.stringify(entries('c2')[1]!.payload), /file content only/);
  for (const [id, name] of [['c3', 'end_thread'], ['c4', 'call'], ['c5', 'call']]) {
    assert.deepEqual(entries(id).map(event => [event.type, event.payload.functionName]), [
      ['tool.call.started', name], ['tool.call.failed', name],
    ]);
  }
});
