// Threads as the console sees them: the snapshot window plus everything the
// tail started or finished, by id; the current page of the list (ids in
// order, cursor, filters); the parent → children index. The fold of events
// into a thread is the server's (src/projections/thread.ts).

import type { Thread, ThreadCounts } from '../../../core/contract.ts';
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
  // page of the server; a terminal the tail brings moves one across. Null
  // until the first page of the set lands.
  counts: ThreadCounts | null;
};

// A thread asked for by id (LOAD_THREAD): in flight, or how it failed.
export type ThreadLookup = { loading: boolean; error: ApiFailure | null };

export type ThreadsState = {
  byId: Record<string, Thread>;
  list: ThreadsListState;
  childrenOf: Record<string, string[]>;
  lookup: Record<string, ThreadLookup>;
};

export const initialThreads: ThreadsState = {
  byId: {},
  list: { ids: [], nextCursor: null, loading: false, filters: null, error: null, counts: null },
  childrenOf: {},
  lookup: {},
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

      return { ...state, byId, childrenOf: indexChildren(byId) };
    }
    case 'LOAD_THREADS':
      return { ...state, list: { ...state.list, loading: true, error: null, filters: action.filters, ...(action.before === null ? { ids: [], nextCursor: null, counts: null } : {}) } };
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

      return { ...state, byId, childrenOf: indexChildren(byId), list: { ...state.list, ids, nextCursor: action.nextCursor, loading: false, error: null, counts: action.counts ?? state.list.counts } };
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

      return { ...state, byId: { ...state.byId, [known.id]: ended }, list: countEnded(state.list, known, ended) };
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

// A thread of the loaded set that just ended moves between the counts of
// the segments: one fewer active, one more under its terminal status.
function countEnded(list: ThreadsListState, before: Thread, after: Thread): ThreadsListState {
  const { counts, filters } = list;

  if (!counts || !filters || before.status !== 'active' || after.status === 'active' || !inFilterSet(after, filters)) {
    return list;
  }

  return { ...list, counts: { ...counts, active: Math.max(0, counts.active - 1), [after.status]: counts[after.status] + 1 } };
}

function sameRequest(list: ThreadsListState, action: { filters: ThreadsListFilters; before: bigint | null }): boolean {
  return list.loading && list.filters === action.filters;
}
