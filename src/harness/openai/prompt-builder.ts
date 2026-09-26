// Assembles the first request of a model turn so that consecutive turns
// extend each other byte-for-byte and hit the OpenAI prompt cache. Port of v1
// runner/prompt-builder generalized per THREAD (§8.1): state and cache key
// are keyed by threadId, which makes the builder reusable by any future
// non-SDK agent, not only the coordinator.
//
// The cache works at breakpoints: the implicit one sits at the latest user
// message, and tools+instructions form an atomic head — any byte change there
// resets everything. Hence the scheme: while the head hash is unchanged, each
// turn appends one new input_text chunk rendered from the events that arrived
// since the previous turn, and the previously sent chunks are resent
// byte-identical. When the head changes, the accumulated chunks overflow, or
// the coverage breaks, the transcript is rebuilt from scratch (a reset).
//
// The price is accepted deliberately: between resets old chunks are frozen —
// no age decay across chunk boundaries — so the model's view is no longer a
// pure function of the log. The volatile part is compensated outside the
// frozen prefix: the status tail (a developer message after the chunks)
// carries the authoritative time (and, from stage 3, active children) every
// turn. State lives in process memory only; a restart is just a reset.

import crypto from 'node:crypto';
import type { ResponseInput } from 'openai/resources/responses/responses';
import { buildTranscript } from './transcript.ts';

type PromptEvent = Parameters<typeof buildTranscript>[0][number] & { seq: bigint };

// Accumulated chunk budget. On overflow the next turn rebuilds the
// transcript from scratch (which is itself bounded by the transcript's own
// char budget), so the cycle is: rebuild → grow → reset.
const MAX_TOTAL_CHARS = 200_000;

// Lifetime of a cached prefix on GPT-5.6+ models: 30 minutes after its last
// write or reuse, the only supported prompt_cache_options.ttl. Measured on
// the live log, the cliff is sharp — ~95% reuse at 26–30 minutes, ~10% at
// 30–34, none afterwards — so "may retain longer" is not to be counted on.
// Once the prefix is cold, appending is strictly worse than resetting: the
// accumulated fat chunks would be resent at the full write rate, while a
// rebuild sends the compact fresh transcript for the same price. The
// coordinator keeps the prefix warm across pauses with prewarm pings
// (markPromptStateWarm), which is what makes appending after a long pause
// legitimate.
export const PROMPT_CACHE_TTL_MS = 30 * 60 * 1000;

type PromptState = {
  headHash: string;
  chunks: string[];
  totalChars: number;
  lastSeq: bigint; // the log is covered by chunks up to this seq inclusive
  lastWarmAt: number; // Date.now() of the last request that reused/wrote the prefix
};

const states = new Map<string, PromptState>();

type BuildTurnPromptOptions = {
  threadId: string;
  // Transcript snapshot of the thread, oldest first.
  events: PromptEvent[];
  // Seq of the newest snapshot event.
  lastSeq: bigint;
  // True when the snapshot hit the history limit: older thread events exist
  // beyond its start, so coverage continuity cannot be assumed.
  snapshotFull: boolean;
  model: string;
  instructions: string;
  // Final serialized tool definitions — hashed as bytes: the cache prefix
  // depends on the exact serialization, not on logical equality.
  tools: readonly unknown[];
  // Volatile status rendered fresh every turn (current time; active children
  // from stage 3). Appended after the chunks as a developer message and
  // deliberately kept out of the state and the head hash: it changes every
  // turn, and the cache prefix must not depend on it. Next turn's chunk
  // replaces it in the same position, so the frozen prefix stays
  // byte-identical.
  statusText: string;
};

export type TurnPrompt = {
  input: ResponseInput;
  cacheKey: string;
};

function isWarm(state: PromptState): boolean {
  return Date.now() - state.lastWarmAt <= PROMPT_CACHE_TTL_MS;
}

function headHashOf(model: string, instructions: string, tools: readonly unknown[]): string {
  return crypto.createHash('sha256').update(JSON.stringify({ model, instructions, tools })).digest('hex');
}

function toInput(chunks: string[], statusText: string): ResponseInput {
  return [
    ...chunks.map(text => ({
      role: 'user' as const,
      content: [{ type: 'input_text' as const, text }],
    })),
    {
      role: 'developer' as const,
      content: [{ type: 'input_text' as const, text: statusText }],
    },
  ];
}

/**
 * Builds the input of the turn's first request. Returns null when the new
 * events render to nothing — the model has nothing to react to and the turn
 * should be skipped entirely; the events stay uncovered and ride along with
 * the next chunk.
 */
export function buildTurnPrompt({
  threadId,
  events,
  lastSeq,
  snapshotFull,
  model,
  instructions,
  tools,
  statusText,
}: BuildTurnPromptOptions): TurnPrompt | null {
  const headHash = headHashOf(model, instructions, tools);

  const state = states.get(threadId);
  // Coverage is continuous when the snapshot reaches back into the range
  // already covered by chunks; a full snapshot starting past lastSeq may
  // have lost events in between.
  const covers = Boolean(state) && (!snapshotFull || (events.length > 0 && events[0]!.seq <= state!.lastSeq));
  const fresh = Boolean(state) && isWarm(state!);

  if (state && state.headHash === headHash && state.totalChars <= MAX_TOTAL_CHARS && covers && fresh) {
    const newEvents = events.filter(event => event.seq > state.lastSeq);

    if (!newEvents.length) {
      return null;
    }

    const { text, dropped } = buildTranscript(newEvents);

    // dropped means even the fresh slice alone overflows the transcript
    // budget — only a full rebuild handles that correctly.
    if (!dropped) {
      if (!text) {
        return null;
      }

      state.chunks.push(text);
      state.totalChars += text.length + 1;
      state.lastSeq = lastSeq;
      state.lastWarmAt = Date.now();

      return { input: toInput(state.chunks, statusText), cacheKey: threadId };
    }
  }

  const { text } = buildTranscript(events);

  if (!text) {
    states.delete(threadId);

    return null;
  }

  states.set(threadId, {
    headHash,
    chunks: [text],
    totalChars: text.length,
    lastSeq,
    lastWarmAt: Date.now(),
  });

  // Stable per thread and never rotated: the key routes requests to the
  // machine that holds the cache, so after a transcript reset the unchanged
  // head can still be served warm.
  return { input: toInput([text], statusText), cacheKey: threadId };
}

// A restart of the owning run drops its builder state explicitly (the next
// turn is a clean rebuild); process restarts drop everything implicitly.
export function resetPromptState(threadId: string): void {
  states.delete(threadId);
}

export type KeepalivePrompt = TurnPrompt & { lastSeq: bigint };

type BuildKeepalivePromptOptions = Pick<BuildTurnPromptOptions, 'threadId' | 'model' | 'instructions' | 'tools' | 'statusText'>;

/**
 * The prompt of a prewarm ping: the thread's frozen chunks as the last turn
 * sent them, under the same head. Null when there is nothing worth keeping
 * warm — no state, a changed head (the next turn rebuilds anyway) or a
 * prefix already past its TTL (rewriting a cold prefix speculatively costs
 * as much as the cold turn it would save).
 */
export function buildKeepalivePrompt({
  threadId,
  model,
  instructions,
  tools,
  statusText,
}: BuildKeepalivePromptOptions): KeepalivePrompt | null {
  const state = states.get(threadId);

  if (!state || state.headHash !== headHashOf(model, instructions, tools) || !isWarm(state)) {
    return null;
  }

  return { input: toInput(state.chunks, statusText), cacheKey: threadId, lastSeq: state.lastSeq };
}

// A successful prewarm ping extends the prefix lifetime by another TTL.
export function markPromptStateWarm(threadId: string): void {
  const state = states.get(threadId);

  if (state) {
    state.lastWarmAt = Date.now();
  }
}
