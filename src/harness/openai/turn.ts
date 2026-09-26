// The inner loop of one model turn over the OpenAI Responses API (§8.1):
// tool_choice: 'required', parallel calls, previous_response_id between
// iterations. Synchronous tool results return to the model in the same turn
// as function_call_output; async dispatches (messages, future spawns) are
// acknowledged with 'accepted' and their consequences arrive as later events.
// Dispatch errors come back to the model in the same turn so it can recover.
//
// Also home of the prompt-cache prewarm ping (prewarmPrompt): the same
// request shape with prompt_cache_options.prewarm, which refreshes the
// cached prefix without generating output. The two share one request
// builder on purpose — any parameter that differs between them would be a
// different cache entry.

import type { ResponseCreateParamsNonStreaming, ResponseInput } from 'openai/resources/responses/responses';
import type { ToolResult } from '../../core/contract.ts';
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
  | { kind: 'async' }
  // Rejected at dispatch; the error goes back so the model can recover
  // in the same turn.
  | { kind: 'rejected'; error: string };

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
};

export type TurnOutcome = {
  // Id of the turn's first response — the next baseline for cache
  // diagnostics.
  firstResponseId: string;
};

export async function runTurn({
  model,
  instructions,
  tools,
  prompt,
  metrics,
  dispatch,
  cacheComparisonResponseId,
}: RunTurnOptions): Promise<TurnOutcome> {
  const client = getOpenaiClient();

  let input: ResponseInput = prompt.input;
  let previousResponseId: string | undefined;
  let firstResponseId: string | undefined;

  while (true) {
    const response = await metrics.measure(() =>
      client.responses.create({
        ...baseRequest({ model, instructions, tools }, input),
        ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
        prompt_cache_key: prompt.cacheKey,
        ...(!previousResponseId && cacheComparisonResponseId
          ? { prompt_cache_options: { comparison_response_id: cacheComparisonResponseId } }
          : {}),
      }),
    );

    previousResponseId = response.id;
    firstResponseId ??= response.id;

    const functionCalls = response.output.filter(item => item.type === 'function_call');

    if (!functionCalls.length) {
      throw new Error(`OpenAI response ${response.id} contains no function calls`);
    }

    const outputs: FunctionCallOutputItem[] = [];
    let hasSyncResult = false;

    for (const functionCall of functionCalls) {
      const outcome = await dispatch({
        callId: functionCall.call_id,
        name: functionCall.name,
        arguments: functionCall.arguments,
      });

      switch (outcome.kind) {
        case 'sync':
          hasSyncResult = true;
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
          // Counts as a sync result: the model must see the rejection and
          // gets the chance to recover within the same turn.
          hasSyncResult = true;
          outputs.push({
            type: 'function_call_output',
            call_id: functionCall.call_id,
            output: `rejected: ${outcome.error}`,
          });
          break;
      }
    }

    if (!hasSyncResult) {
      return { firstResponseId };
    }

    input = outputs;
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
