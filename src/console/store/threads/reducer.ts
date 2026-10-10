// Threads as the console sees them: the snapshot window plus everything the
// tail started or finished, by id; the current page of the list (ids in
// order, cursor, filters); the parent → children index. The fold of events
// into a thread is the server's (src/projections/thread.ts).

import type { Event, Thread, ThreadCounts } from '../../../core/contract.ts';
import type { EventOf } from '../../../core/event-types.ts';
import { threadCompletionFields, threadStartFields, threadStatusFrom } from '../../../projections/thread.ts';
import type { ApiFailure } from '../../lib/api/index.ts';
import { isEventAction } from '../events.ts';
import type { Action } from '../types.ts';
import { inFilterSet } from './filters.ts';
import type { ThreadsListFilters } from './filters.ts';

export type ThreadsListState = {
  ids: string[];
  nextCursor: bigint | null;
  loading: boolean;
  filters: ThreadsListFilters | null;
  error: ApiFailure | null;
  // How many threads of the set fall under each status, from the first
  // page of the server, exact at countsAsOfSeq (the server's stamp): a
  // terminal above the stamp — whether the tail brings it or a row of a
  // page shows it — adds one under its status, one below is already in.
  // The screen reads the closed numbers here and the active one from the
  // store, so `active` stays the server's at the stamp. Null until the
  // first page of the set lands (a stamp is null when the server gave none).
  counts: ThreadCounts | null;
  countsAsOfSeq: bigint | null;
};

// A thread asked for by id (LOAD_THREAD): in flight, or how it failed.
export type ThreadLookup = { loading: boolean; error: ApiFailure | null };

export type ThreadsState = {
  byId: Record<string, Thread>;
  list: ThreadsListState;
  childrenOf: Record<string, string[]>;
  lookup: Record<string, ThreadLookup>;
  // The newest message of the main thread's feed as the snapshot knew it —
  // the pinned row's words before the thread's events are loaded (the feed
  // holds none of a thread the tab has not opened until the tail brings
  // one). Null until the snapshot, or while the thread has no message.
  mainLastMessage: Event | null;
};

export const initialThreads: ThreadsState = {
  byId: {},
  list: { ids: [], nextCursor: null, loading: false, filters: null, error: null, counts: null, countsAsOfSeq: null },
  childrenOf: {},
  lookup: {},
  mainLastMessage: null,
};

function indexChildren(byId: Record<string, Thread>): Record<string, string[]> {
  const childrenOf: Record<string, string[]> = {};

  for (const thread of Object.values(byId).sort((a, b) => (a.createdSeq < b.createdSeq ? -1 : a.createdSeq > b.createdSeq ? 1 : 0))) {
    if (thread.parentId) {
      (childrenOf[thread.parentId] ??= []).push(thread.id);
    }
  }

  return childrenOf;
}

function mergeThreads(byId: Record<string, Thread>, threads: Thread[]): Record<string, Thread> {
  const next = { ...byId };

  for (const thread of threads) {
    const known = next[thread.id];

    // A list page can be older than what the tail already folded in.
    if (!known || known.updatedAt <= thread.updatedAt) {
      next[thread.id] = thread;
    }
  }

  return next;
}

function threadFromStarted(event: EventOf<'thread.started'>): Thread | null {
  if (!event.threadId) {
    return null;
  }

  const { agent, title, projectId } = threadStartFields(event.payload);

  return {
    id: event.threadId,
    userId: event.userId ?? '',
    parentId: event.targetThreadId,
    agent,
    title,
    description: null,
    status: 'active',
    summary: null,
    projectId,
    headless: event.payload.headless === true,
    createdSeq: event.seq,
    terminalSeq: null,
    createdAt: event.createdAt,
    updatedAt: event.createdAt,
  };
}

export function threadsReducer(state: ThreadsState = initialThreads, action: Action): ThreadsState {
  switch (action.type) {
    case 'SNAPSHOT_LOAD_DONE': {
      const byId = mergeThreads(state.byId, action.snapshot.threads);

      return { ...state, byId, childrenOf: indexChildren(byId), mainLastMessage: action.snapshot.mainLastMessage };
    }
    case 'LOAD_THREADS':
      return { ...state, list: { ...state.list, loading: true, error: null, filters: action.filters, ...(action.before === null ? { ids: [], nextCursor: null, counts: null, countsAsOfSeq: null } : {}) } };
    case 'LOAD_THREADS_DONE': {
      if (!sameRequest(state.list, action)) {
        return state;
      }

      const byId = mergeThreads(state.byId, action.threads);
      const ids = action.before === null ? [] : [...state.list.ids];

      for (const thread of action.threads) {
        if (!ids.includes(thread.id)) {
          ids.push(thread.id);
        }
      }

      const counted = action.counts ? { counts: countsWithTail(action.counts, action.countsAsOfSeq, byId, action.filters), countsAsOfSeq: action.countsAsOfSeq } : {};

      return { ...state, byId, childrenOf: indexChildren(byId), list: { ...state.list, ids, nextCursor: action.nextCursor, loading: false, error: null, ...counted } };
    }
    case 'LOAD_THREADS_FAIL':
      return sameRequest(state.list, action) ? { ...state, list: { ...state.list, loading: false, error: action.error } } : state;
    case 'LOAD_THREAD':
      return { ...state, lookup: { ...state.lookup, [action.id]: { loading: true, error: null } } };
    case 'LOAD_THREAD_DONE': {
      const byId = mergeThreads(state.byId, [action.thread]);
      const { [action.id]: dropped, ...lookup } = state.lookup;

      void dropped;

      return { ...state, byId, childrenOf: indexChildren(byId), lookup };
    }
    case 'LOAD_THREAD_FAIL':
      return state.lookup[action.id]?.loading ? { ...state, lookup: { ...state.lookup, [action.id]: { loading: false, error: action.error } } } : state;
    case 'event/thread.started': {
      const thread = threadFromStarted(action.event);

      if (!thread || state.byId[thread.id]) {
        return state;
      }

      const byId = { ...state.byId, [thread.id]: thread };

      return { ...state, byId, childrenOf: indexChildren(byId) };
    }
    case 'event/thread.completed':
    case 'event/thread.failed':
    case 'event/thread.cancelled': {
      const { event } = action;
      const known = event.threadId ? state.byId[event.threadId] : undefined;

      if (!known || (known.terminalSeq !== null && known.terminalSeq >= event.seq)) {
        return state;
      }

      const status = threadStatusFrom(event.type) ?? known.status;
      const completion = event.type === 'thread.completed' ? threadCompletionFields(event.payload) : {};
      const ended: Thread = {
        ...known,
        status,
        terminalSeq: event.seq,
        updatedAt: event.createdAt,
        ...(completion.summary !== undefined ? { summary: completion.summary } : {}),
        ...(completion.title !== undefined ? { title: completion.title } : {}),
        ...(completion.description !== undefined ? { description: completion.description } : {}),
      };

      return { ...state, byId: { ...state.byId, [known.id]: ended }, list: countEnded(state.list, known, ended, event.seq) };
    }
    default: {
      // Any event of a thread at work is its activity. A finished thread
      // keeps the time of its terminal: a late tail of its journal (allowed
      // by the log) is a fact about a closed author, not activity — and
      // the row of the snapshot stops at the terminal the same way.
      if (isEventAction(action)) {
        const { event } = action;
        const known = event.threadId ? state.byId[event.threadId] : undefined;

        if (known && known.status === 'active' && known.updatedAt < event.createdAt) {
          return { ...state, byId: { ...state.byId, [known.id]: { ...known, updatedAt: event.createdAt } } };
        }
      }

      return state;
    }
  }
}

// A thread of the set that just ended adds one under its terminal status —
// unless the terminal is at or below the stamp of the counts, which have
// it already (the page landed after the event committed; the tail is only
// now delivering it).
function countEnded(list: ThreadsListState, before: Thread, after: Thread, seq: bigint): ThreadsListState {
  const { counts, countsAsOfSeq, filters } = list;

  if (!counts || !filters || before.status !== 'active' || after.status === 'active' || !inFilterSet(after, filters) || (countsAsOfSeq !== null && seq <= countsAsOfSeq)) {
    return list;
  }

  return { ...list, counts: { ...counts, [after.status]: counts[after.status] + 1 } };
}

// The counts of a first page brought up to the store: a thread of the set
// the store already knows closed above the stamp (its terminal arrived
// through the tail while the page was in flight, or a row of the page is
// newer than the stamp) is counted under its status here — the event has
// been folded already, or will be skipped by countEnded as known.
function countsWithTail(counts: ThreadCounts, asOfSeq: bigint | null, byId: Record<string, Thread>, filters: ThreadsListFilters): ThreadCounts {
  if (asOfSeq === null) {
    return counts;
  }

  const next = { ...counts };

  for (const thread of Object.values(byId)) {
    if (thread.status !== 'active' && thread.terminalSeq !== null && thread.terminalSeq > asOfSeq && inFilterSet(thread, filters)) {
      next[thread.status] += 1;
    }
  }

  return next;
}

function sameRequest(list: ThreadsListState, action: { filters: ThreadsListFilters; before: bigint | null }): boolean {
  return list.loading && list.filters === action.filters;
}
