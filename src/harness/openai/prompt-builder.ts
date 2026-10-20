// Assembles the prompt of a model turn's first request so that consecutive
// turns extend each other byte-for-byte and hit the backend's prompt cache
// (OpenAI's explicit cache, Anthropic's cache_control breakpoints — the
// turn drivers render the chunks into their wire shapes). Port of v1
// runner/prompt-builder generalized per THREAD (§8.1): state and cache key
// are keyed by threadId, which makes the builder reusable by any future
// non-SDK agent, not only the coordinator.
//
// The cache works at breakpoints: the one at the latest transcript chunk,
// and tools+instructions form an atomic head — any byte change there
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
import { config } from '../../config/index.ts';
import type { PrewarmPrompt, TurnPrompt } from '../turn-contract.ts';
import { getLlmBackend } from './backend.ts';
import { buildTranscript } from './transcript.ts';

type PromptEvent = Parameters<typeof buildTranscript>[0][number] & { seq: bigint };

// Accumulated chunk budget. On overflow the next turn rebuilds the
// transcript from scratch (which is itself bounded by the transcript's own
// char budget), so the cycle is: rebuild → grow → reset.
const MAX_TOTAL_CHARS = 200_000;

// The transcript budget of a rebuild (and of every turn on a backend with an
// automatic prompt cache, see buildTurnPrompt).
const transcriptOptions = () => ({ charLimit: config.coordinatorTranscriptChars });

// Lifetime of a cached prefix: the backend's (backend.ts — 30 minutes on
// OpenAI, 1 hour on Anthropic). Once the prefix is cold, appending is
// strictly worse than resetting: the accumulated fat chunks would be resent
// at the full write rate, while a rebuild sends the compact fresh transcript
// for the same price. The coordinator keeps the prefix warm across pauses
// with prewarm pings (markPromptStateWarm), which is what makes appending
// after a long pause legitimate.
const promptCacheTtlMs = () => getLlmBackend().promptCacheTtlMs;

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
  // from stage 3). Rendered after the chunks (a developer message on
  // OpenAI, a system message on Anthropic) and deliberately kept out of the
  // state and the head hash: it changes every turn, and the cache prefix
  // must not depend on it. Next turn's chunk replaces it in the same
  // position, so the frozen prefix stays byte-identical.
  statusText: string;
};

function isWarm(state: PromptState): boolean {
  return Date.now() - state.lastWarmAt <= promptCacheTtlMs();
}

function headHashOf(model: string, instructions: string, tools: readonly unknown[]): string {
  return crypto.createHash('sha256').update(JSON.stringify({ model, instructions, tools })).digest('hex');
}

function toPrompt(chunks: string[], statusText: string, cacheKey: string): TurnPrompt {
  return { chunks, statusText, cacheKey };
}

/**
 * Builds the prompt of the turn's first request. Returns null when the new
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
  // Without an explicit prompt cache there is nothing to freeze: the
  // transcript is rebuilt from the log every turn — the model's view is a
  // pure function of the log, and the server's automatic prefix cache still
  // serves the heavy, byte-identical head (instructions + tools) for free.
  if (getLlmBackend().promptCache !== 'explicit') {
    const { text } = buildTranscript(events, transcriptOptions());

    return text ? toPrompt([text], statusText, threadId) : null;
  }

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

    const { text, dropped } = buildTranscript(newEvents, transcriptOptions());

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

      return toPrompt([...state.chunks], statusText, threadId);
    }
  }

  const { text } = buildTranscript(events, transcriptOptions());

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
  return toPrompt([text], statusText, threadId);
}

// A restart of the owning run drops its builder state explicitly (the next
// turn is a clean rebuild); process restarts drop everything implicitly.
export function resetPromptState(threadId: string): void {
  states.delete(threadId);
}

export type KeepalivePrompt = PrewarmPrompt & { lastSeq: bigint };

type BuildKeepalivePromptOptions = Pick<BuildTurnPromptOptions, 'threadId' | 'model' | 'instructions' | 'tools'>;

/**
 * The prompt of a prewarm ping: the thread's frozen chunks as the last turn
 * sent them, under the same head — and nothing after them: the status tail
 * is no part of the cached prefix. Null when there is nothing worth keeping
 * warm — no state, a changed head (the next turn rebuilds anyway) or a
 * prefix already past its TTL (rewriting a cold prefix speculatively costs
 * as much as the cold turn it would save).
 */
export function buildKeepalivePrompt({ threadId, model, instructions, tools }: BuildKeepalivePromptOptions): KeepalivePrompt | null {
  const state = states.get(threadId);

  if (!state || state.headHash !== headHashOf(model, instructions, tools) || !isWarm(state)) {
    return null;
  }

  return { chunks: [...state.chunks], cacheKey: threadId, lastSeq: state.lastSeq };
}

// A successful prewarm ping extends the prefix lifetime by another TTL.
export function markPromptStateWarm(threadId: string): void {
  const state = states.get(threadId);

  if (state) {
    state.lastWarmAt = Date.now();
  }
}
