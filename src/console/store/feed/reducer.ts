// The events of threads, by seq, and per thread the ordered list of seqs it
// shows (authored in it or addressed to it — src/projections/feed.ts). The
// tail writes every event it brings, open thread or not; a chunk loaded on
// request fills the range below knownFrom. Idempotent by seq: a seq already
// known is ignored, so the overlap of snapshot and tail is harmless.
// Eviction (FEED_EVICT, decided by lib/feed-eviction) takes a thread's feed
// out whole — its seq list, its cursor, and every event of it no kept
// feed lists as well (an event is in the feeds of both its author and its
// addressee; a kept feed holds it only while its seq list has it — a feed
// brought back in part, by a chunk from the head or a late frame of the
// tail, lacks what it has not loaded) — so the thread reads as never
// loaded, and its next opening asks for a chunk from the head. Every event
// of the store is in the list of at least one feed.

import type { Event } from '../../../core/contract.ts';
import { feedThreadIds } from '../../../projections/feed.ts';
import type { ApiFailure } from '../../lib/api/index.ts';
import { isEventAction } from '../events.ts';
import type { Action } from '../types.ts';

export type ThreadFeed = {
  // Ascending seqs, as decimal strings (bigint cannot key an object).
  seqs: string[];
  // The oldest seq loaded on request; null — nothing requested yet. From
  // here to the head the feed is complete.
  knownFrom: bigint | null;
  exhausted: boolean;
  request: { before: bigint | null } | null;
  error: ApiFailure | null;
};

export type FeedState = {
  byThread: Record<string, ThreadFeed>;
  events: Record<string, Event>;
};

export const initialFeed: FeedState = { byThread: {}, events: {} };

export const emptyFeed: ThreadFeed = { seqs: [], knownFrom: null, exhausted: false, request: null, error: null };

// The place of seq in the ascending list: its index when present, else
// the index it would take.
function bisect(seqs: string[], seq: bigint): { at: number; found: boolean } {
  let low = 0;
  let high = seqs.length;

  while (low < high) {
    const mid = (low + high) >> 1;
    const here = BigInt(seqs[mid]);

    if (here === seq) {
      return { at: mid, found: true };
    }

    if (here < seq) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  return { at: low, found: false };
}

// Inserts seq into the ascending list unless present; returns the same
// array when nothing changed.
export function insertSeq(seqs: string[], seq: bigint): string[] {
  const { at, found } = bisect(seqs, seq);

  return found ? seqs : [...seqs.slice(0, at), seq.toString(), ...seqs.slice(at)];
}

export function hasSeq(seqs: string[], seq: bigint): boolean {
  return bisect(seqs, seq).found;
}

function addEvents(state: FeedState, events: Event[], onThread?: (feed: ThreadFeed, threadId: string) => ThreadFeed): FeedState {
  let changed = false;
  const nextEvents = { ...state.events };
  const nextByThread = { ...state.byThread };

  for (const event of events) {
    const key = event.seq.toString();

    if (!nextEvents[key]) {
      nextEvents[key] = event;
      changed = true;
    }

    for (const threadId of feedThreadIds(event)) {
      const feed = nextByThread[threadId] ?? emptyFeed;
      const seqs = insertSeq(feed.seqs, event.seq);

      if (seqs !== feed.seqs) {
        nextByThread[threadId] = { ...feed, seqs };
        changed = true;
      }
    }
  }

  if (onThread) {
    for (const threadId of Object.keys(nextByThread)) {
      nextByThread[threadId] = onThread(nextByThread[threadId], threadId);
    }
  }

  return changed || onThread ? { byThread: nextByThread, events: nextEvents } : state;
}

export function feedReducer(state: FeedState = initialFeed, action: Action): FeedState {
  switch (action.type) {
    case 'LOAD_THREAD_EVENTS': {
      const feed = state.byThread[action.threadId] ?? emptyFeed;

      return { ...state, byThread: { ...state.byThread, [action.threadId]: { ...feed, request: { before: action.before }, error: null } } };
    }
    case 'LOAD_THREAD_EVENTS_DONE': {
      const feed = state.byThread[action.threadId] ?? emptyFeed;

      if (feed.request?.before !== action.before) {
        return state;
      }

      const oldest = action.events.reduce<bigint | null>((min, event) => (min === null || event.seq < min ? event.seq : min), null);
      const knownFrom = oldest === null ? (feed.knownFrom ?? action.before) : feed.knownFrom === null || oldest < feed.knownFrom ? oldest : feed.knownFrom;
      const withEvents = addEvents(state, action.events);
      const current = withEvents.byThread[action.threadId] ?? feed;

      return {
        ...withEvents,
        byThread: {
          ...withEvents.byThread,
          [action.threadId]: { ...current, knownFrom, exhausted: action.nextCursor === null, request: null, error: null },
        },
      };
    }
    case 'LOAD_THREAD_EVENTS_FAIL': {
      const feed = state.byThread[action.threadId] ?? emptyFeed;

      return feed.request?.before === action.before
        ? { ...state, byThread: { ...state.byThread, [action.threadId]: { ...feed, request: null, error: action.error } } }
        : state;
    }
    case 'FEED_EVICT': {
      const gone = action.threadIds.filter(threadId => state.byThread[threadId]);

      if (gone.length === 0) {
        return state;
      }

      const byThread = { ...state.byThread };

      for (const threadId of gone) {
        delete byThread[threadId];
      }

      const events = { ...state.events };

      for (const threadId of gone) {
        for (const seq of state.byThread[threadId]!.seqs) {
          const event = events[seq];

          // The other feed of the event (its author's or its addressee's)
          // is still here and lists it: the event stays with it.
          if (event && !feedThreadIds(event).some(other => byThread[other] !== undefined && hasSeq(byThread[other].seqs, event.seq))) {
            delete events[seq];
          }
        }
      }

      return { byThread, events };
    }
    default:
      return isEventAction(action) ? addEvents(state, [action.event]) : state;
  }
}
