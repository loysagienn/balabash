import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Response, ResponseCreateParamsNonStreaming } from 'openai/resources/responses/responses';
import { MAX_TURN_ITERATIONS, runTurn } from './turn.ts';
import type { DispatchResult, FunctionCall, TurnClient } from './turn.ts';

type Call = { name: string; callId?: string; args?: string };

// A scripted model: one response per request, each a list of function
// calls; records every request it received.
function makeClient(script: Call[][]) {
  const requests: Array<Record<string, unknown>> = [];
  let next = 0;

  const client: TurnClient = {
    responses: {
      create: async (params: ResponseCreateParamsNonStreaming) => {
        requests.push(params as unknown as Record<string, unknown>);

        const calls = script[next] ?? [];

        next += 1;

        return {
          id: `resp-${next}`,
          output: calls.map((call, index) => ({
            type: 'function_call',
            call_id: call.callId ?? `call-${next}-${index}`,
            name: call.name,
            arguments: call.args ?? '{}',
          })),
        } as unknown as Response;
      },
    },
  };

  return { client, requests };
}

const metrics = { measure: <T>(fn: () => Promise<T>) => fn() } as unknown as Parameters<typeof runTurn>[0]['metrics'];
const head: Pick<Parameters<typeof runTurn>[0], 'model' | 'instructions' | 'tools' | 'prompt'> = {
  model: 'm',
  instructions: 'i',
  tools: [],
  prompt: { input: [{ role: 'user', content: 'hello' }], cacheKey: 'k' },
};
const stateful = { kind: 'openai' as const, baseUrl: null, statefulTurns: true, promptCache: 'explicit' as const };
const stateless = { kind: 'openai-compatible' as const, baseUrl: null, statefulTurns: false, promptCache: 'automatic' as const };

function dispatcher(kinds: Record<string, DispatchResult>) {
  const dispatched: string[] = [];
  const dispatch = async (call: FunctionCall): Promise<DispatchResult> => {
    dispatched.push(call.name);

    return kinds[call.name] ?? { kind: 'rejected', error: `unknown ${call.name}` };
  };

  return { dispatch, dispatched };
}

describe('runTurn', () => {
  it('continues after an async-only response and ends only on do_nothing', async () => {
    const { client, requests } = makeClient([[{ name: 'send_to_thread' }], [{ name: 'engineer' }], [{ name: 'do_nothing' }]]);
    const { dispatch, dispatched } = dispatcher({
      send_to_thread: { kind: 'async' },
      engineer: { kind: 'async' },
      do_nothing: { kind: 'end' },
    });

    const outcome = await runTurn({ ...head, metrics, dispatch, deps: { client, backend: stateful } });

    assert.deepEqual(dispatched, ['send_to_thread', 'engineer', 'do_nothing']);
    assert.equal(requests.length, 3);
    assert.equal(outcome.firstResponseId, 'resp-1');

    // The async call was acknowledged to the model, chained through
    // previous_response_id.
    assert.equal(requests[1]!.previous_response_id, 'resp-1');
    assert.deepEqual(requests[1]!.input, [{ type: 'function_call_output', call_id: 'call-1-0', output: 'accepted' }]);
  });

  it('dispatches every call of one response, do_nothing among them ends the turn after the others', async () => {
    const { client, requests } = makeClient([[{ name: 'send_message' }, { name: 'manager' }, { name: 'do_nothing' }]]);
    const { dispatch, dispatched } = dispatcher({
      send_message: { kind: 'async' },
      manager: { kind: 'async' },
      do_nothing: { kind: 'end' },
    });

    await runTurn({ ...head, metrics, dispatch, deps: { client, backend: stateful } });

    assert.deepEqual(dispatched, ['send_message', 'manager', 'do_nothing']);
    assert.equal(requests.length, 1);
  });

  it('returns sync results and rejections to the model and keeps going', async () => {
    const { client, requests } = makeClient([
      [{ name: 'get_event', callId: 'a' }, { name: 'bogus', callId: 'b' }],
      [{ name: 'do_nothing' }],
    ]);
    const { dispatch } = dispatcher({
      get_event: { kind: 'sync', result: { content: [{ type: 'text', text: 'the event' }] } as DispatchResult extends { result: infer R } ? R : never },
      do_nothing: { kind: 'end' },
    });

    await runTurn({ ...head, metrics, dispatch, deps: { client, backend: stateful } });

    assert.equal(requests.length, 2);

    const outputs = requests[1]!.input as Array<{ call_id: string; output: unknown }>;

    assert.equal(outputs.length, 2);
    assert.equal(outputs[0]!.call_id, 'a');
    assert.equal(outputs[1]!.call_id, 'b');
    assert.match(String(outputs[1]!.output), /^rejected: unknown bogus/);
  });

  it('stateless backend: resends the whole input with the response output echoed', async () => {
    const { client, requests } = makeClient([[{ name: 'send_message', callId: 'c1' }], [{ name: 'do_nothing' }]]);
    const { dispatch } = dispatcher({ send_message: { kind: 'async' }, do_nothing: { kind: 'end' } });

    await runTurn({ ...head, metrics, dispatch, deps: { client, backend: stateless } });

    assert.equal(requests[1]!.previous_response_id, undefined);

    const input = requests[1]!.input as Array<Record<string, unknown>>;

    assert.deepEqual(input[0], { role: 'user', content: 'hello' });
    assert.equal(input[1]!.type, 'function_call');
    assert.deepEqual(input[2], { type: 'function_call_output', call_id: 'c1', output: 'accepted' });
  });

  it('fails loudly when the model never ends the turn', async () => {
    const script = Array.from({ length: MAX_TURN_ITERATIONS + 1 }, () => [{ name: 'send_message' }]);
    const { client, requests } = makeClient(script);
    const { dispatch } = dispatcher({ send_message: { kind: 'async' } });

    await assert.rejects(
      runTurn({ ...head, metrics, dispatch, deps: { client, backend: stateful } }),
      /did not end within 16 iterations/,
    );
    assert.equal(requests.length, MAX_TURN_ITERATIONS);
  });

  it('rejects a response without function calls', async () => {
    const { client } = makeClient([[]]);
    const { dispatch } = dispatcher({});

    await assert.rejects(runTurn({ ...head, metrics, dispatch, deps: { client, backend: stateful } }), /contains no function calls/);
  });
});
