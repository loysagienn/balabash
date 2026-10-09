// The inner loop of one model turn over the OpenAI Responses API (§8.1):
// tool_choice: 'required', parallel calls. Every call's outcome returns to
// the model in the same turn as function_call_output — synchronous tool
// results as they are, async dispatches (messages, spawns) as 'accepted'
// (their consequences arrive as later events), dispatch errors as
// 'rejected: …' so the model can recover — and the model may call more.
// The turn ends only when the model says so: an 'end' dispatch (the
// coordinator's do_nothing). Before 2026-10-09 an all-async response ended
// the turn by itself, which cut every step-by-step plan short: the model
// (one call per response, the next after the result) notified a child and
// never got to spawn the agent the user had asked for.
//
// How one iteration continues into the next is the backend's business
// (backend.ts): with stateful turns the next request carries
// previous_response_id and only the outputs; without them it carries the
// whole input so far plus the response's own output items (function_call,
// reasoning, message — a reasoning model needs its reasoning echoed back)
// plus the outputs. Everything else about the request is identical.
//
// Also home of the prompt-cache prewarm ping (prewarmPrompt, explicit
// prompt cache only): the same request shape with
// prompt_cache_options.prewarm, which refreshes the cached prefix without
// generating output. The two share one request builder on purpose — any
// parameter that differs between them would be a different cache entry.

import type {
  Response,
  ResponseCreateParamsNonStreaming,
  ResponseInput,
  ResponseInputItem,
} from 'openai/resources/responses/responses';
import type { ToolResult } from '../../core/contract.ts';
import { getLlmBackend } from './backend.ts';
import type { LlmBackend } from './backend.ts';
import { getOpenaiClient } from './client.ts';
import { toolResultToModelOutput } from './content.ts';
import type { ModelOutput } from './content.ts';
import type { TurnPrompt } from './prompt-builder.ts';
import type { startLlmRequestMetrics } from './llm-metrics.ts';

export type FunctionDefinition = {
  type: 'function';
  name: string;
  description: string;
  strict: boolean;
  parameters: Record<string, unknown>;
};

export type FunctionCall = {
  callId: string;
  name: string;
  arguments: string;
};

export type DispatchResult =
  // The result goes back to the model and the loop continues.
  | { kind: 'sync'; result: ToolResult }
  // Accepted for asynchronous execution; consequences arrive as events.
  // Acknowledged to the model as 'accepted' and the loop continues.
  | { kind: 'async' }
  // Rejected at dispatch; the error goes back so the model can recover
  // in the same turn.
  | { kind: 'rejected'; error: string }
  // The model declares the turn over: nothing more to do for the newest
  // events. The other calls of the same response are still dispatched.
  | { kind: 'end' };

// A turn that never ends is a model looping on itself (sending message
// after message, re-spawning); the cap turns it into a journaled failure
// (the coordinator journals a thrown turn as system.exception).
export const MAX_TURN_ITERATIONS = 16;

type FunctionCallOutputItem = {
  type: 'function_call_output';
  call_id: string;
  output: ModelOutput;
};

type RequestHead = {
  model: string;
  instructions: string;
  tools: FunctionDefinition[];
};

// The request parameters shared by every call of a thread: the prompt-cache
// prefix depends on them (model, instructions, tools, reasoning), so turns
// and prewarm pings must agree byte for byte.
function baseRequest({ model, instructions, tools }: RequestHead, input: ResponseInput): ResponseCreateParamsNonStreaming {
  return {
    model,
    instructions,
    input,
    tools,
    tool_choice: 'required',
    parallel_tool_calls: true,
  };
}

type RunTurnOptions = RequestHead & {
  prompt: TurnPrompt;
  metrics: ReturnType<typeof startLlmRequestMetrics>;
  dispatch: (call: FunctionCall) => Promise<DispatchResult>;
  // Response id of the thread's previous request with this prefix; when set,
  // the first request asks the server for prompt-cache diagnostics against
  // it (free; recorded by the metrics).
  cacheComparisonResponseId?: string | null;
  // Test seam: the client and the backend description, the real ones by
  // default.
  deps?: {
    client?: TurnClient;
    backend?: LlmBackend;
  };
};

// What the loop needs of the OpenAI client — the SDK client satisfies it,
// a scripted fake in tests too.
export type TurnClient = {
  responses: { create(params: ResponseCreateParamsNonStreaming): Promise<Response> };
};

export type TurnOutcome = {
  // Id of the turn's first response — the next baseline for cache
  // diagnostics.
  firstResponseId: string;
};

// The next iteration's request continuation: the two ways a turn carries its
// own history, see the header.
type Continuation = { input: ResponseInput; previousResponseId?: string };

function continueStateful(response: Response, outputs: FunctionCallOutputItem[]): Continuation {
  return { input: outputs, previousResponseId: response.id };
}

function continueStateless(input: ResponseInput, response: Response, outputs: FunctionCallOutputItem[]): Continuation {
  const history = typeof input === 'string' ? [{ role: 'user' as const, content: input }] : input;

  return { input: [...history, ...(response.output as ResponseInputItem[]), ...outputs] };
}

export async function runTurn({
  model,
  instructions,
  tools,
  prompt,
  metrics,
  dispatch,
  cacheComparisonResponseId,
  deps,
}: RunTurnOptions): Promise<TurnOutcome> {
  const client: TurnClient = deps?.client ?? getOpenaiClient();
  const backend = deps?.backend ?? getLlmBackend();
  const explicitCache = backend.promptCache === 'explicit';

  let input: ResponseInput = prompt.input;
  let previousResponseId: string | undefined;
  let firstResponseId: string | undefined;

  for (let iteration = 1; ; iteration += 1) {
    if (iteration > MAX_TURN_ITERATIONS) {
      throw new Error(`turn did not end within ${MAX_TURN_ITERATIONS} iterations (the model never called do_nothing)`);
    }

    const response = await metrics.measure(() =>
      client.responses.create({
        ...baseRequest({ model, instructions, tools }, input),
        ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
        ...(explicitCache ? { prompt_cache_key: prompt.cacheKey } : {}),
        ...(explicitCache && !firstResponseId && cacheComparisonResponseId
          ? { prompt_cache_options: { comparison_response_id: cacheComparisonResponseId } }
          : {}),
      }),
    );

    firstResponseId ??= response.id;

    const functionCalls = response.output.filter(item => item.type === 'function_call');

    if (!functionCalls.length) {
      throw new Error(`OpenAI response ${response.id} contains no function calls`);
    }

    const outputs: FunctionCallOutputItem[] = [];
    let ended = false;

    for (const functionCall of functionCalls) {
      const outcome = await dispatch({
        callId: functionCall.call_id,
        name: functionCall.name,
        arguments: functionCall.arguments,
      });

      switch (outcome.kind) {
        case 'sync':
          outputs.push({
            type: 'function_call_output',
            call_id: functionCall.call_id,
            output: await toolResultToModelOutput(outcome.result, functionCall.name),
          });
          break;

        case 'async':
          outputs.push({
            type: 'function_call_output',
            call_id: functionCall.call_id,
            output: 'accepted',
          });
          break;

        case 'rejected':
          // The model must see the rejection and gets the chance to recover
          // within the same turn.
          outputs.push({
            type: 'function_call_output',
            call_id: functionCall.call_id,
            output: `rejected: ${outcome.error}`,
          });
          break;

        case 'end':
          ended = true;
          break;
      }
    }

    if (ended) {
      return { firstResponseId };
    }

    const next = backend.statefulTurns
      ? continueStateful(response, outputs)
      : continueStateless(input, response, outputs);

    input = next.input;
    previousResponseId = next.previousResponseId;
  }
}

type PrewarmOptions = RequestHead & {
  prompt: TurnPrompt;
  metrics: ReturnType<typeof startLlmRequestMetrics>;
  cacheComparisonResponseId?: string | null;
};

/**
 * Refreshes the prompt-cache prefix of a thread: the same request as a
 * turn's first one, with prompt_cache_options.prewarm — the server reuses
 * (or writes) the prefix and generates nothing. On a warm prefix this is a
 * pure cached read; on a cold one it writes the prefix at the write rate,
 * which the next real turn then finds warm. Returns the response id.
 */
export async function prewarmPrompt({
  model,
  instructions,
  tools,
  prompt,
  metrics,
  cacheComparisonResponseId,
}: PrewarmOptions): Promise<string> {
  if (getLlmBackend().promptCache !== 'explicit') {
    throw new Error('prewarmPrompt requires a backend with an explicit prompt cache');
  }

  const client = getOpenaiClient();

  const response = await metrics.measure(() =>
    client.responses.create({
      ...baseRequest({ model, instructions, tools }, prompt.input),
      prompt_cache_key: prompt.cacheKey,
      prompt_cache_options: {
        prewarm: true,
        ...(cacheComparisonResponseId ? { comparison_response_id: cacheComparisonResponseId } : {}),
      },
    }),
  );

  return response.id;
}
