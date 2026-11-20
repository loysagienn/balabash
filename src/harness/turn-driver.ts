// The turn driver of the configured backend (openai/backend.ts): the
// coordinator asks for one and runs its turns and prewarm pings through it,
// never naming a provider. Each driver starts its own request metrics from
// the neutral context — the two usage shapes differ, the llm_requests row
// does not.

import { getLlmBackend } from './openai/backend.ts';
import * as openai from './openai/turn.ts';
import { startLlmRequestMetrics as startOpenaiMetrics } from './openai/llm-metrics.ts';
import * as anthropic from './anthropic/turn.ts';
import { startLlmRequestMetrics as startAnthropicMetrics } from './anthropic/llm-metrics.ts';
import type { DispatchResult, FunctionCall, LlmRequestContext, PrewarmPrompt, RequestHead, TurnOutcome, TurnPrompt } from './turn-contract.ts';

export type TurnRunOptions = RequestHead & {
  prompt: TurnPrompt;
  metrics: LlmRequestContext;
  dispatch: (call: FunctionCall) => Promise<DispatchResult>;
  // A text answer of the model, where the backend allows one (Anthropic):
  // the coordinator delivers it to the user as its own message.
  deliverText: (text: string) => Promise<void>;
  // Response id of the thread's previous request with this prefix; the
  // OpenAI driver asks the server for prompt-cache diagnostics against it.
  cacheComparisonResponseId?: string | null;
};

export type PrewarmOptions = RequestHead & {
  prompt: PrewarmPrompt;
  metrics: LlmRequestContext;
  cacheComparisonResponseId?: string | null;
};

export type TurnDriver = {
  runTurn: (options: TurnRunOptions) => Promise<TurnOutcome>;
  prewarmPrompt: (options: PrewarmOptions) => Promise<string>;
};

// Optional scripted clients exercise both the turn and keepalive paths.
export type TurnClients = { client?: openai.TurnClient; anthropicClient?: anthropic.AnthropicTurnClient };

export function getTurnDriver({ client, anthropicClient }: TurnClients = {}): TurnDriver {
  if (getLlmBackend().kind === 'anthropic') {
    const deps = { client: anthropicClient };
    return {
      runTurn: ({ metrics, ...options }) => anthropic.runTurn({ ...options, metrics: startAnthropicMetrics(metrics), deps }),
      prewarmPrompt: ({ metrics, ...options }) => anthropic.prewarmPrompt({ ...options, metrics: startAnthropicMetrics(metrics), deps }),
    };
  }
  return {
    runTurn: ({ metrics, ...options }) => openai.runTurn({ ...options, metrics: startOpenaiMetrics(metrics), deps: { client } }),
    prewarmPrompt: ({ metrics, ...options }) => openai.prewarmPrompt({ ...options, metrics: startOpenaiMetrics(metrics), client }),
  };
}
