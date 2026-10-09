import type { Thread } from '../../../core/contract.ts';
import type { Event } from '../../../core/contract.ts';
import type { ApiFailure } from '../../lib/api/index.ts';
import type { ThreadsListFilters } from './filters.ts';

// A page of the threads list: before = the cursor of the previous page
// (null — the first page). Filters travel with the action so a late answer
// to an old filter set is recognised and dropped.
export const loadThreads = (filters: ThreadsListFilters, before: bigint | null) => ({ type: 'LOAD_THREADS', filters, before }) as const;
export const loadThreadsDone = (filters: ThreadsListFilters, before: bigint | null, threads: Thread[], nextCursor: bigint | null) =>
  ({ type: 'LOAD_THREADS_DONE', filters, before, threads, nextCursor }) as const;
export const loadThreadsFail = (filters: ThreadsListFilters, before: bigint | null, error: ApiFailure) =>
  ({ type: 'LOAD_THREADS_FAIL', filters, before, error }) as const;

// A chunk of a thread's feed, newest down: before = the feed's knownFrom, or
// null for "from the head" (the handler resolves it to asOfSeq + 1 — what
// comes after asOfSeq the tail delivers).
export const loadThreadEvents = (threadId: string, before: bigint | null) => ({ type: 'LOAD_THREAD_EVENTS', threadId, before }) as const;
export const loadThreadEventsDone = (threadId: string, before: bigint | null, events: Event[], nextCursor: bigint | null) =>
  ({ type: 'LOAD_THREAD_EVENTS_DONE', threadId, before, events, nextCursor }) as const;
export const loadThreadEventsFail = (threadId: string, before: bigint | null, error: ApiFailure) =>
  ({ type: 'LOAD_THREAD_EVENTS_FAIL', threadId, before, error }) as const;
