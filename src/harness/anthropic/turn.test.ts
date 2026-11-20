import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type Anthropic from '@anthropic-ai/sdk';
import { MAX_TURN_ITERATIONS } from '../turn-contract.ts';
import type { CatalogResult, FunctionCall, FunctionDefinition, RequestHead, TurnPrompt } from '../turn-contract.ts';
import { startStand } from '../../test-support/stand.ts';
import { prewarmPrompt, runTurn } from './turn.ts';
import type { AnthropicTurnClient } from './turn.ts';

type Scripted = { text?: string; calls?: Array<{ name: string; id?: string; input?: Record<string, unknown> }> };

// A scripted model: one response per request — optional text, then tool
// calls (stop_reason tool_use when there are any, end_turn otherwise);
// records every request it received.
function makeClient(script: Scripted[]) {
  const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  let next = 0;

  const client: AnthropicTurnClient = {
    messages: {
      create: async params => {
        // The loop grows its messages array in place; the record is what
        // the wire would have carried at this request.
        requests.push(structuredClone(params));

        const step = script[next] ?? {};

        next += 1;

        const content: Anthropic.ContentBlock[] = [
          { type: 'thinking', thinking: '', signature: `sig-${next}` },
          ...(step.text ? [{ type: 'text' as const, text: step.text, citations: null }] : []),
          ...(step.calls ?? []).map((call, index) => ({
            type: 'tool_use' as const,
            id: call.id ?? `call-${next}-${index}`,
            name: call.name,
            input: call.input ?? {},
            caller: { type: 'direct' as const },
          })),
        ];

        return {
          id: `msg-${next}`,
          type: 'message',
          role: 'assistant',
          model: 'm',
          content,
          stop_reason: step.calls?.length ? 'tool_use' : 'end_turn',
          stop_sequence: null,
          stop_details: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        } as unknown as Anthropic.Message;
      },
    },
  };

  return { client, requests };
}

const metrics = { measure: <T>(fn: () => Promise<T>) => fn() } as unknown as Parameters<typeof runTurn>[0]['metrics'];
const schema = { type: 'object', properties: {} };
const leaf: FunctionDefinition = { type: 'function', name: 'projects_list', description: 'List projects', strict: false, parameters: schema };
const head: RequestHead & { prompt: TurnPrompt } = {
  model: 'm',
  instructions: 'i',
  tools: [{ type: 'function', name: 'describe', description: 'Open an entry', strict: false, parameters: schema }],
  deferredTools: [leaf],
  prompt: { chunks: ['older', 'newest'], statusText: 'status', cacheKey: 'k' },
};

function dispatcher(kinds: Record<string, CatalogResult>) {
  const dispatched: FunctionCall[] = [];
  const dispatch = async (call: FunctionCall): Promise<CatalogResult> => {
    dispatched.push(call);

    return kinds[call.name] ?? { kind: 'catalog', isError: true, text: `unknown ${call.name}` };
  };

  return { dispatch, dispatched };
}

function collector() {
  const delivered: string[] = [];

  return { delivered, deliverText: async (text: string) => void delivered.push(text) };
}

describe('anthropic runTurn', () => {
  it('renders the prompt with breakpoints on the instructions and the last chunk, the status as a system message', async () => {
    const { client, requests } = makeClient([{}]);
    const { dispatch } = dispatcher({});
    const { deliverText } = collector();

    await runTurn({ ...head, metrics, dispatch, deliverText, deps: { client, effort: 'medium' } });

    const request = requests[0]!;

    assert.deepEqual(request.system, [{ type: 'text', text: 'i', cache_control: { type: 'ephemeral', ttl: '1h' } }]);
    assert.deepEqual(request.tool_choice, { type: 'auto' });
    assert.deepEqual(request.output_config, { effort: 'medium' });
    assert.deepEqual(request.tools, [
      { name: 'describe', description: 'Open an entry', input_schema: schema },
      { name: 'projects_list', description: 'List projects', input_schema: schema, defer_loading: true },
    ]);
    assert.deepEqual(request.messages, [
      { role: 'user', content: [{ type: 'text', text: 'older' }] },
      { role: 'user', content: [{ type: 'text', text: 'newest', cache_control: { type: 'ephemeral', ttl: '1h' } }] },
      { role: 'system', content: 'status' },
    ]);
  });

  it('a prewarm ping is the same request up to the last breakpoint — no status after it — with max_tokens 0', async () => {
    const { client, requests } = makeClient([{}]);
    const { dispatch } = dispatcher({});
    const { deliverText } = collector();

    await runTurn({ ...head, metrics, dispatch, deliverText, deps: { client, effort: 'medium' } });
    await prewarmPrompt({ ...head, prompt: { chunks: head.prompt.chunks, cacheKey: head.prompt.cacheKey }, metrics, deps: { client, effort: 'medium' } });

    const [turn, ping] = requests as [Anthropic.MessageCreateParamsNonStreaming, Anthropic.MessageCreateParamsNonStreaming];

    assert.equal(ping.max_tokens, 0);
    assert.deepEqual(ping.messages, turn.messages.slice(0, -1));
    assert.deepEqual(ping.messages.at(-1), { role: 'user', content: [{ type: 'text', text: 'newest', cache_control: { type: 'ephemeral', ttl: '1h' } }] });
    assert.deepEqual({ ...ping, messages: null, max_tokens: null }, { ...turn, messages: null, max_tokens: null });
  });

  it('delivers text as the message to the user and ends on a response without tool calls', async () => {
    const { client, requests } = makeClient([{ text: 'Hello there' }]);
    const { dispatch, dispatched } = dispatcher({});
    const { delivered, deliverText } = collector();

    const outcome = await runTurn({ ...head, metrics, dispatch, deliverText, deps: { client } });

    assert.deepEqual(delivered, ['Hello there']);
    assert.equal(dispatched.length, 0);
    assert.equal(requests.length, 1);
    assert.equal(outcome.firstResponseId, 'msg-1');
  });

  it('puts all results before labeled opening notes and echoes thinking and tool uses', async () => {
    const { client, requests } = makeClient([
      { text: 'On it', calls: [{ name: 'describe', id: 'a', input: { name: leaf.name } }, { name: 'bogus', id: 'b' }] },
      { calls: [{ name: leaf.name, id: 'c' }] },
      {},
    ]);
    const { dispatch, dispatched } = dispatcher({
      describe: { kind: 'catalog', text: 'Returns: Project[]', definition: leaf },
      [leaf.name]: { kind: 'catalog', text: '[]' },
    });
    const { delivered, deliverText } = collector();

    await runTurn({ ...head, metrics, dispatch, deliverText, deps: { client } });

    assert.deepEqual(delivered, ['On it']);
    assert.deepEqual(dispatched.map(call => call.callId), ['a', 'b', 'c']);
    assert.deepEqual(requests[1]!.tools, requests[0]!.tools);
    const second = requests[1]!.messages;
    assert.equal(second[3]!.role, 'assistant');
    assert.equal((second[3]!.content as Anthropic.ContentBlock[])[0]!.type, 'thinking');
    assert.deepEqual(second[4], { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'a', content: [{ type: 'tool_reference', tool_name: leaf.name }] },
      { type: 'tool_result', tool_use_id: 'b', content: 'unknown bogus', is_error: true },
      { type: 'text', text: 'Opened: projects_list\nReturns: Project[]' },
    ] });
    assert.deepEqual(requests[2]!.messages.at(-1), { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'c', content: '[]' },
    ] });
  });

  it('attaches the image or PDF to the direct view_file result', async () => {
    for (const kind of ['image', 'pdf'] as const) {
      const url = 'https://files.test/' + kind;
      const { client, requests } = makeClient([{ calls: [{ name: 'view_file', id: 'v' }] }, {}]);
      const { dispatch } = dispatcher({ view_file: { kind: 'catalog', text: 'file ref', attachment: { kind, url } } });
      await runTurn({ ...head, metrics, dispatch, ...collector(), deps: { client } });
      assert.deepEqual(requests[1]!.messages.at(-1), { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'v', content: [
          { type: 'text', text: 'file ref' },
          { type: kind === 'image' ? 'image' : 'document', source: { type: 'url', url } },
        ] },
      ] });
    }
  });

  it('fails loudly when the model never stops calling tools', async () => {
    const script = Array.from({ length: MAX_TURN_ITERATIONS + 1 }, () => ({ calls: [{ name: 'send_to_thread' }] }));
    const { client, requests } = makeClient(script);
    const { dispatch } = dispatcher({ send_to_thread: { kind: 'catalog', text: 'null' } });
    const { deliverText } = collector();

    await assert.rejects(runTurn({ ...head, metrics, dispatch, deliverText, deps: { client } }), /did not end within 16 iterations/);
    assert.equal(requests.length, MAX_TURN_ITERATIONS);
  });

  it('a refusal or a cut response is the turn failure', async () => {
    const { client } = makeClient([{}]);
    const refusing: AnthropicTurnClient = {
      messages: {
        create: async params => ({ ...(await client.messages.create(params)), stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: 'no' } }) as Anthropic.Message,
      },
    };
    const { dispatch } = dispatcher({});
    const { delivered, deliverText } = collector();

    await assert.rejects(runTurn({ ...head, metrics, dispatch, deliverText, deps: { client: refusing } }), /stopped: refusal \(cyber: no\)/);
    assert.equal(delivered.length, 0);
  });
});

it('replays a journaled opening at its chunk boundary in the Anthropic secretary turn and keepalive', async t => {
  const stand = await startStand();
  t.after(() => stand.stop());
  process.env.LLM_BACKEND = 'anthropic';
  t.after(() => { delete process.env.LLM_BACKEND; });

  const { coordinatorPort } = await import('../../coordinator/port.ts');
  const { buildTurnPrompt, buildKeepalivePrompt, catalogOpenings } = await import('../openai/prompt-builder.ts');
  const { getTranscript } = await import('../../core/events.ts');
  const { mainThreadId: threadId, workspaceId } = stand;
  const port = await coordinatorPort(workspaceId, threadId);
  const request = { ...port.head, model: 'm' };
  assert.deepEqual(request.tools.map(fn => fn.name), ['describe', 'run_program']);
  assert.match(request.instructions, /plain text you write is sent to the user/);
  assert.doesNotMatch(request.instructions, /do_nothing|storage_get_file/);
  assert.ok('deferredTools' in request && request.deferredTools);
  const deferred = request.deferredTools.map(fn => fn.name);
  assert.ok(deferred.includes('projects_list'));
  assert.ok(!deferred.includes('end_thread') && !deferred.includes('projects') && !deferred.includes('gmail_get_thread'));

  const prefix = { ...request, threadId, grantKey: port.grantKey };
  const snapshot = async () => {
    const events = await getTranscript(threadId, { last: 400, omitProgramCalls: true });
    return { ...prefix, events, lastSeq: events.at(-1)!.seq, snapshotFull: false, statusText: 'status' };
  };
  const prompt = buildTurnPrompt(await snapshot());
  assert.ok(prompt);
  const { client, requests } = makeClient([
    { calls: [{ name: 'describe', id: 'open-list', input: { name: 'projects_list' } }] },
    { calls: [{ name: 'projects_list', id: 'list', input: {} }] },
    { text: 'Done' },
  ]);
  const openings = catalogOpenings(threadId);
  const dispatch = async (call: FunctionCall) => port.dispatch(call, openings);
  const { delivered, deliverText } = collector();
  await runTurn({ ...request, prompt, metrics, dispatch, deliverText, deps: { client } });
  assert.deepEqual(delivered, ['Done']);
  assert.deepEqual(requests[1]!.tools, requests[0]!.tools);
  const events = (await snapshot()).events;
  const completed = events.filter(event => event.type === 'tool.call.completed');
  assert.deepEqual(completed.map(event => event.payload.callId), ['open-list', 'list']);
  assert.equal((completed[0]!.payload.value as { name: string }).name, 'projects_list');
  assert.doesNotMatch(JSON.stringify(completed[0]!.payload), /tool_reference|defer_loading/);

  const warm = buildKeepalivePrompt(prefix);
  assert.ok(warm);
  const ping = async (frozen: typeof warm) => {
    await prewarmPrompt({ ...request, prompt: frozen, metrics, deps: { client } });
    return requests.at(-1)!;
  };
  const firstPing = await ping(warm);
  assert.equal(firstPing.max_tokens, 0);
  const pair = firstPing.messages.slice(1);
  assert.deepEqual(pair[0], { role: 'assistant', content: [
    { type: 'tool_use', id: 'open-list', name: 'describe', input: { name: 'projects_list' } },
  ] });
  const live = requests[1]!.messages.at(-1)!.content as [Anthropic.ToolResultBlockParam, Anthropic.TextBlockParam];
  assert.deepEqual(live[0].content, [{ type: 'tool_reference', tool_name: 'projects_list' }]);
  assert.match(live[1].text, /Returns:/);
  assert.deepEqual(pair[1], { role: 'user', content: [live[0], { ...live[1], cache_control: { type: 'ephemeral', ttl: '1h' } }] });

  const next = buildTurnPrompt(await snapshot());
  assert.ok(next);
  await runTurn({ ...request, prompt: next, metrics, dispatch, deliverText, deps: { client } });
  const secondTurn = requests.at(-1)!;
  assert.deepEqual(secondTurn.messages[1], pair[0]);
  assert.deepEqual(secondTurn.messages[2], { role: 'user', content: live });
  assert.match(JSON.stringify(secondTurn.messages[3]), /projects_list/);
  assert.deepEqual((await ping(buildKeepalivePrompt(prefix)!)).messages, secondTurn.messages.slice(0, -1));

  const reduced = { ...prefix, deferredTools: request.deferredTools.filter(fn => fn.name !== 'projects_list') };
  assert.equal(buildKeepalivePrompt(reduced), null);
  const rebuilt = buildTurnPrompt({ ...await snapshot(), ...reduced });
  assert.ok(rebuilt);
  assert.deepEqual(rebuilt.openings ?? [], []);
});
