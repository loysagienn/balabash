import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type Anthropic from '@anthropic-ai/sdk';
import { MAX_TURN_ITERATIONS } from '../turn-contract.ts';
import type { DispatchResult, FunctionCall } from '../turn-contract.ts';
import { runTurn } from './turn.ts';
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
const head: Pick<Parameters<typeof runTurn>[0], 'model' | 'instructions' | 'tools' | 'prompt'> = {
  model: 'm',
  instructions: 'i',
  tools: [
    { type: 'function', name: 'send_to_thread', description: 'd', strict: true, parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } },
    {
      type: 'function',
      name: 'nullable',
      description: 'n',
      strict: true,
      parameters: { type: 'object', properties: { fileIds: { type: ['array', 'null'], items: { type: 'string' } } }, required: ['fileIds'], additionalProperties: false },
    },
  ],
  prompt: { chunks: ['older', 'newest'], statusText: 'status', cacheKey: 'k' },
};

function dispatcher(kinds: Record<string, DispatchResult>) {
  const dispatched: FunctionCall[] = [];
  const dispatch = async (call: FunctionCall): Promise<DispatchResult> => {
    dispatched.push(call);

    return kinds[call.name] ?? { kind: 'rejected', error: `unknown ${call.name}` };
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
    // Strict only without union types: the API caps those per request.
    assert.deepEqual(request.tools, [
      { name: 'send_to_thread', description: 'd', strict: true, input_schema: head.tools[0]!.parameters },
      { name: 'nullable', description: 'n', strict: false, input_schema: head.tools[1]!.parameters },
    ]);
    assert.deepEqual(request.messages, [
      { role: 'user', content: [{ type: 'text', text: 'older' }] },
      { role: 'user', content: [{ type: 'text', text: 'newest', cache_control: { type: 'ephemeral', ttl: '1h' } }] },
      { role: 'system', content: 'status' },
    ]);
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

  it('continues after tool calls with the response echoed and the results in one user message', async () => {
    const { client, requests } = makeClient([
      { text: 'On it', calls: [{ name: 'send_to_thread', id: 'a', input: { threadId: 't' } }, { name: 'bogus', id: 'b' }] },
      { calls: [{ name: 'get_event', id: 'c' }] },
      {},
    ]);
    const { dispatch, dispatched } = dispatcher({
      send_to_thread: { kind: 'async' },
      get_event: { kind: 'sync', result: { content: [{ type: 'text', text: 'the event' }] } as Extract<DispatchResult, { kind: 'sync' }>['result'] },
    });
    const { delivered, deliverText } = collector();

    await runTurn({ ...head, metrics, dispatch, deliverText, deps: { client } });

    assert.deepEqual(delivered, ['On it']);
    assert.deepEqual(
      dispatched.map(call => [call.name, call.callId, call.arguments]),
      [
        ['send_to_thread', 'a', '{"threadId":"t"}'],
        ['bogus', 'b', '{}'],
        ['get_event', 'c', '{}'],
      ],
    );
    assert.equal(requests.length, 3);

    const second = requests[1]!.messages;

    // chunks + status, then the echoed assistant content (thinking included)
    // and all results of the response in one user message.
    assert.equal(second.length, 5);
    assert.equal(second[3]!.role, 'assistant');
    assert.equal((second[3]!.content as Anthropic.ContentBlock[])[0]!.type, 'thinking');
    assert.deepEqual(second[4], {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'a', content: 'accepted' },
        { type: 'tool_result', tool_use_id: 'b', content: 'rejected: unknown bogus', is_error: true },
      ],
    });

    const third = requests[2]!.messages;

    assert.equal(third.length, 7);
    assert.deepEqual(third[6], { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c', content: 'the event' }] });
  });

  it('an end dispatch ends the turn without another request', async () => {
    const { client, requests } = makeClient([{ calls: [{ name: 'do_nothing' }] }]);
    const { dispatch } = dispatcher({ do_nothing: { kind: 'end' } });
    const { deliverText } = collector();

    await runTurn({ ...head, metrics, dispatch, deliverText, deps: { client } });

    assert.equal(requests.length, 1);
  });

  it('fails loudly when the model never stops calling tools', async () => {
    const script = Array.from({ length: MAX_TURN_ITERATIONS + 1 }, () => ({ calls: [{ name: 'send_to_thread' }] }));
    const { client, requests } = makeClient(script);
    const { dispatch } = dispatcher({ send_to_thread: { kind: 'async' } });
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
