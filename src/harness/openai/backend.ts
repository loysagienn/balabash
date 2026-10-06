// The one description of the OpenAI-shaped backend the harness talks to —
// the single reader of
// config.llmBackend. Everything else asks this object instead of the env:
// the turn loop (stateful vs stateless iterations), the prompt builder
// (incremental chunks vs a fresh transcript), the coordinator (keep-alive
// pings) and the metrics (provider).
//
// 'openai' — api.openai.com: a turn's iterations chain through
//   previous_response_id, the prompt cache is explicit (prompt_cache_key,
//   prompt_cache_options: prewarm / comparison) with a 30-minute TTL worth
//   keeping warm.
// 'openai-compatible' — a Responses API server without server-side state
//   (LiteLLM over vLLM): every iteration resends the whole input with the
//   previous output items echoed back (function_call, reasoning, message);
//   caching is the server's automatic prefix cache — free, no TTL, nothing
//   to ping — so the prompt is simply rebuilt from the log every turn.

import { config } from '../../config/index.ts';

export type LlmBackend = {
  kind: 'openai' | 'openai-compatible';
  baseUrl: string | null;
  // Iterations of one turn chain server-side (previous_response_id) or
  // carry the whole conversation themselves.
  statefulTurns: boolean;
  // 'explicit': OpenAI's prompt cache — byte-identical frozen prefixes,
  // cache options, prewarm pings. 'automatic': the server caches prefixes on
  // its own; the client does nothing special.
  promptCache: 'explicit' | 'automatic';
};

function describeBackend(): LlmBackend {
  const kind = config.llmBackend;

  return {
    kind,
    baseUrl: config.openaiBaseUrl,
    statefulTurns: kind === 'openai',
    promptCache: kind === 'openai' ? 'explicit' : 'automatic',
  };
}

let backend: LlmBackend | null = null;

export function getLlmBackend(): LlmBackend {
  backend ??= describeBackend();

  return backend;
}
