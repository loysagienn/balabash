// The provider-neutral contract of one model turn of the coordinator (§8.1):
// what the coordinator hands a backend driver and what comes back. Two
// drivers implement it — src/harness/openai/turn.ts (the Responses API, for
// the 'openai' and 'openai-compatible' backends) and
// src/harness/anthropic/turn.ts (the Messages API); turn-driver.ts picks one
// by the configured backend. Nothing here names a provider's wire shapes.

import type { ToolResult } from '../core/contract.ts';

// A tool the model may call: the one definition shape of the coordinator's
// port, serialized per driver. Catalog functions allow omitted optional
// fields and validate them when called. Legacy strict schemas require every key.
export type FunctionDefinition = {
  type: 'function';
  name: string;
  description: string;
  strict: boolean;
  parameters: Record<string, unknown>;
};

// The catalog entries introduced under the current prompt prefix.
export type CatalogOpeningContext = {
  seenNodes: Set<string>;
  introduce(callId: string, definition: FunctionDefinition, text: string): boolean;
};

// One call the model made, arguments as the JSON text the dispatcher parses.
export type FunctionCall = {
  callId: string;
  name: string;
  arguments: string;
};

export type CatalogResult = {
  kind: 'catalog';
  text: string;
  isError?: true;
  definition?: FunctionDefinition;
  attachment?: { kind: 'image' | 'pdf'; url: string };
};

export type DispatchResult =
  // The result goes back to the model and the loop continues.
  | { kind: 'sync'; result: ToolResult }
  | CatalogResult
  // Accepted for asynchronous execution; consequences arrive as events.
  // The legacy Responses driver acknowledges the call as 'accepted'.
  | { kind: 'async' }
  // Rejected at dispatch; the error goes back so the model can recover
  // in the same turn.
  | { kind: 'rejected'; error: string }
  // The model declares the turn over: nothing more to do for the newest
  // events. The other calls of the same response are still dispatched.
  | { kind: 'end' };

// The prompt of a turn's first request, as the prompt builder assembles it
// (src/harness/openai/prompt-builder.ts): the frozen transcript chunks —
// byte-identical across turns while the cache prefix lives — and the
// volatile status tail rendered fresh every turn. Each driver renders the
// two into its provider's message shapes.
export type TurnPrompt = {
  chunks: string[];
  // Definitions introduced after each frozen transcript chunk, in opening order.
  openings?: { afterChunk: number; callId: string; definition: FunctionDefinition; text: string }[];
  statusText: string;
  // Stable per thread: routes requests to the machine holding the cache
  // where the provider supports such routing (OpenAI's prompt_cache_key).
  cacheKey: string;
};

// The prompt of a prewarm ping: the frozen chunks alone. The status rides
// after the last cache breakpoint and is no part of the prefix a ping
// refreshes — sending it would only be paid for at the uncached rate.
export type PrewarmPrompt = Pick<TurnPrompt, 'chunks' | 'cacheKey' | 'openings'>;

// The request parameters shared by every call of a thread: the prompt-cache
// prefix depends on them (model, instructions, tools), so turns and prewarm
// pings must agree byte for byte.
export type RequestHead = {
  model: string;
  instructions: string;
  tools: FunctionDefinition[];
  // Declared in the request but loaded into context only by a reference.
  deferredTools?: FunctionDefinition[];
};

// The telemetry context of a turn's requests (llm_requests rows).
export type LlmRequestContext = {
  workspaceId: string;
  threadId: string;
  lastSeq: bigint;
  requestedModel: string;
  // 'turn' — a model turn (1..N requests); 'keepalive' — a prompt-cache
  // prewarm ping (one request, no output).
  purpose: 'turn' | 'keepalive';
};

export type TurnOutcome = {
  // Id of the turn's first response — the next baseline for cache
  // diagnostics where the provider offers them.
  firstResponseId: string;
};

// A turn that never ends is a model looping on itself (sending message
// after message, re-spawning); the cap turns it into a journaled failure
// (the coordinator journals a thrown turn as system.exception).
export const MAX_TURN_ITERATIONS = 16;
