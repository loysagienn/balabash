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

// The server cache guarantees 30 minutes and keeps entries up to 24 hours
// best-effort. After a long pause appending is strictly worse than resetting:
// the accumulated fat chunks would be resent into a cold cache at the full
// write rate, while a rebuild sends the compact fresh transcript for the same
// price. 6h is deliberately conservative — deep in the best-effort zone.
const MAX_STATE_AGE_MS = 6 * 60 * 60 * 1000;

type PromptState = {
  headHash: string;
  chunks: string[];
  totalChars: number;
  lastSeq: bigint; // the log is covered by chunks up to this seq inclusive
  lastTurnAt: number; // Date.now() of the last built prompt
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
  const headHash = crypto.createHash('sha256').update(JSON.stringify({ model, instructions, tools })).digest('hex');

  const state = states.get(threadId);
  // Coverage is continuous when the snapshot reaches back into the range
  // already covered by chunks; a full snapshot starting past lastSeq may
  // have lost events in between.
  const covers = Boolean(state) && (!snapshotFull || (events.length > 0 && events[0]!.seq <= state!.lastSeq));
  const fresh = Boolean(state) && Date.now() - state!.lastTurnAt <= MAX_STATE_AGE_MS;

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
      state.lastTurnAt = Date.now();

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
    lastTurnAt: Date.now(),
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
