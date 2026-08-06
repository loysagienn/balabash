// The inner loop of one model turn over the OpenAI Responses API (§8.1):
// tool_choice: 'required', parallel calls, previous_response_id between
// iterations. Synchronous tool results return to the model in the same turn
// as function_call_output; async dispatches (messages, future spawns) are
// acknowledged with 'accepted' and their consequences arrive as later events.
// Dispatch errors come back to the model in the same turn so it can recover.

import type { ResponseInput } from 'openai/resources/responses/responses';
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

type RunTurnOptions = {
  model: string;
  instructions: string;
  tools: FunctionDefinition[];
  prompt: TurnPrompt;
  metrics: ReturnType<typeof startLlmRequestMetrics>;
  dispatch: (call: FunctionCall) => Promise<DispatchResult>;
};

export async function runTurn({
  model,
  instructions,
  tools,
  prompt,
  metrics,
  dispatch,
}: RunTurnOptions): Promise<void> {
  const client = getOpenaiClient();

  let input: ResponseInput = prompt.input;
  let previousResponseId: string | undefined;

  while (true) {
    const response = await metrics.measure(() =>
      client.responses.create({
        model,
        instructions,
        input,
        ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
        tools,
        tool_choice: 'required',
        parallel_tool_calls: true,
        prompt_cache_key: prompt.cacheKey,
      }),
    );

    previousResponseId = response.id;

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
            output: await toolResultToModelOutput(outcome.result),
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
      return;
    }

    input = outputs;
  }
}
