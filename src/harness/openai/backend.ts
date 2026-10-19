// The one description of the LLM backend the coordinator's harness talks to
// — the single reader of config.llmBackend. Everything else asks this object
// instead of the env: the turn driver (which API, stateful vs stateless
// iterations), the prompt builder (incremental chunks vs a fresh transcript,
// the cache lifetime), the coordinator (keep-alive pings) and the metrics
// (provider).
//
// 'openai' — api.openai.com over the Responses API: a turn's iterations
//   chain through previous_response_id, the prompt cache is explicit
//   (prompt_cache_key, prompt_cache_options: prewarm / comparison) with a
//   30-minute TTL worth keeping warm.
// 'openai-compatible' — a Responses API server without server-side state
//   (LiteLLM over vLLM): every iteration resends the whole input with the
//   previous output items echoed back (function_call, reasoning, message);
//   caching is the server's automatic prefix cache — free, no TTL, nothing
//   to ping — so the prompt is simply rebuilt from the log every turn.
// 'anthropic' — api.anthropic.com over the Messages API
//   (src/harness/anthropic/turn.ts): stateless iterations (the whole
//   conversation plus the response content echoed back); the prompt cache is
//   a prefix match at explicit breakpoints with the 1-hour TTL, kept warm
//   with max_tokens: 0 pings — the same frozen-prefix discipline as OpenAI's
//   explicit cache, under a longer lifetime.

import { config } from '../../config/index.ts';

export type LlmBackendKind = 'openai' | 'openai-compatible' | 'anthropic';

export type LlmBackend = {
  kind: LlmBackendKind;
  baseUrl: string | null;
  // Iterations of one turn chain server-side (previous_response_id) or
  // carry the whole conversation themselves.
  statefulTurns: boolean;
  // 'explicit': the client keeps the prefix byte-identical across turns
  // (frozen chunks) and refreshes it with prewarm pings before the TTL
  // runs out. 'automatic': the server caches prefixes on its own; the
  // client does nothing special.
  promptCache: 'explicit' | 'automatic';
  // Lifetime of a cached prefix after its last write or read — the
  // keep-alive cadence and the warm/cold judgement of the prompt builder
  // follow it. Meaningful for the explicit cache only.
  promptCacheTtlMs: number;
};

// OpenAI: 30 minutes after the last write or reuse, the only supported
// prompt_cache_options.ttl on GPT-5.6+ models. Measured on the live log, the
// cliff is sharp — ~95% reuse at 26–30 minutes, ~10% at 30–34, none
// afterwards — so "may retain longer" is not to be counted on.
const OPENAI_PROMPT_CACHE_TTL_MS = 30 * 60 * 1000;

// Anthropic: the 1-hour cache_control TTL (a write at 2× the input price
// against 1.25× for the 5-minute one — on the coordinator's ~5k new tokens
// per turn a difference of cents a week, while the 5-minute TTL would need
// a ping every 4–5 minutes to survive a pause). A cache read refreshes the
// timer at no extra cost, which is what the pings rely on.
const ANTHROPIC_PROMPT_CACHE_TTL_MS = 60 * 60 * 1000;

function describeBackend(): LlmBackend {
  const kind = config.llmBackend;

  switch (kind) {
    case 'openai':
      return { kind, baseUrl: config.openaiBaseUrl, statefulTurns: true, promptCache: 'explicit', promptCacheTtlMs: OPENAI_PROMPT_CACHE_TTL_MS };
    case 'openai-compatible':
      return { kind, baseUrl: config.openaiBaseUrl, statefulTurns: false, promptCache: 'automatic', promptCacheTtlMs: 0 };
    case 'anthropic':
      return { kind, baseUrl: null, statefulTurns: false, promptCache: 'explicit', promptCacheTtlMs: ANTHROPIC_PROMPT_CACHE_TTL_MS };
  }
}

let backend: LlmBackend | null = null;

export function getLlmBackend(): LlmBackend {
  backend ??= describeBackend();

  return backend;
}
