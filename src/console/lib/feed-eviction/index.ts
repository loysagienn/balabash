// The feed eviction process: the tail writes the events of every thread of
// the workspace into the store, shown or not, and a thread once opened keeps
// its chunks — a tab left open for a day would hold the whole day's log. A
// thread's feed is in use while the thread is on screen (the thread route),
// while the thread runs (its row on the list reads the last action from
// the feed, and it is the one the operator opens next), and for the main
// thread always (its pinned row reads its last message); a feed out of use
// for FEED_TTL_MS is evicted (FEED_EVICT — store/feed) — it reads as never
// loaded, and the thread's next opening asks for a chunk from the head
// (the store's handler counts the head from the tail's last seq, so nothing
// evicted goes missing). A process over the store, like the stream: it
// keeps the clocks itself (when each feed was last written, when the thread
// was last left) and sweeps every FEED_SWEEP_MS.

import type { Store } from 'redux';
import type { AppRoute } from '../router/routes.ts';
import type { Action, State } from '../../store/types.ts';
import { evictFeeds } from '../../store/feed/actions.ts';

export const FEED_TTL_MS = 15 * 60_000;
export const FEED_SWEEP_MS = 60_000;

export type FeedEvictionOptions = {
  // The process's clock, in milliseconds (Date.now in the browser).
  now?: () => number;
  ttlMs?: number;
  sweepMs?: number;
};

// The thread the route shows, if any.
export function viewedThreadId(route: AppRoute): string | null {
  return route.key === 'thread' ? route.id : null;
}

// The feeds whose last use (`touched`: thread id → the clock's reading
// when the feed was last written or the thread last left) is at or before
// `deadline`, among those out of use: not the thread shown, not the main
// thread, not an active thread, not a feed with a chunk in flight. A feed
// without a reading is not yet due.
export function evictableFeeds(state: State, touched: ReadonlyMap<string, number>, deadline: number): string[] {
  const viewed = viewedThreadId(state.router.route);
  const main = state.session.me?.mainThreadId ?? null;
  const due: string[] = [];

  for (const [threadId, feed] of Object.entries(state.feed.byThread)) {
    if (threadId === viewed || threadId === main || feed.request !== null || state.threads.byId[threadId]?.status === 'active') {
      continue;
    }

    const at = touched.get(threadId);

    if (at !== undefined && at <= deadline) {
      due.push(threadId);
    }
  }

  return due;
}

export function connectStoreToFeedEviction(store: Store<State, Action>, { now = Date.now, ttlMs = FEED_TTL_MS, sweepMs = FEED_SWEEP_MS }: FeedEvictionOptions = {}): () => void {
  const touched = new Map<string, number>();
  let seenFeeds = store.getState().feed.byThread;
  let seenViewed = viewedThreadId(store.getState().router.route);

  for (const threadId of Object.keys(seenFeeds)) {
    touched.set(threadId, now());
  }

  // Every change of a thread's feed (a frame of the tail, a chunk, a
  // request) is a use; leaving the thread's screen is one too — the
  // reading period starts when the reading ends. A feed gone from the
  // store (evicted, or the session ended) is forgotten.
  const watch = () => {
    const state = store.getState();
    const feeds = state.feed.byThread;
    const viewed = viewedThreadId(state.router.route);

    if (feeds !== seenFeeds) {
      const at = now();

      for (const threadId of Object.keys(feeds)) {
        if (feeds[threadId] !== seenFeeds[threadId]) {
          touched.set(threadId, at);
        }
      }

      for (const threadId of touched.keys()) {
        if (!feeds[threadId]) {
          touched.delete(threadId);
        }
      }

      seenFeeds = feeds;
    }

    if (viewed !== seenViewed) {
      if (seenViewed !== null && feeds[seenViewed]) {
        touched.set(seenViewed, now());
      }

      seenViewed = viewed;
    }
  };

  const sweep = () => {
    const due = evictableFeeds(store.getState(), touched, now() - ttlMs);

    if (due.length > 0) {
      store.dispatch(evictFeeds(due));
    }
  };

  const unsubscribe = store.subscribe(watch);
  const timer = setInterval(sweep, sweepMs);

  return () => {
    unsubscribe();
    clearInterval(timer);
  };
}
