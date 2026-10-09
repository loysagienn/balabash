import { createSelector } from 'reselect';
import type { Thread } from '../../../core/contract.ts';
import type { State } from '../types.ts';
import type { ThreadsListFilters } from './filters.ts';
import type { ThreadsListState } from './reducer.ts';

export const selectThreadsById = (state: State) => state.threads.byId;
export const selectThreadsList = (state: State) => state.threads.list;
export const selectThread = (state: State, id: string): Thread | undefined => state.threads.byId[id];
export const selectChildCount = (state: State, id: string): number => state.threads.childrenOf[id]?.length ?? 0;

const newestFirst = (a: Thread, b: Thread) => (a.createdSeq > b.createdSeq ? -1 : a.createdSeq < b.createdSeq ? 1 : 0);

// Agent threads at work: active threads below the root (the workspace's
// main thread is always active and is not "work in progress").
export const selectRunningThreads = createSelector([selectThreadsById], byId =>
  Object.values(byId)
    .filter(thread => thread.status === 'active' && thread.parentId !== null)
    .sort(newestFirst),
);

export const selectRunningCount = (state: State) => selectRunningThreads(state).length;

// How many threads are at work for each project (projectId → count).
export const selectRunningCountByProject = createSelector([selectRunningThreads], threads => {
  const counts: Record<string, number> = {};

  for (const thread of threads) {
    if (thread.projectId !== null) {
      counts[thread.projectId] = (counts[thread.projectId] ?? 0) + 1;
    }
  }

  return counts;
});

// The thread that ended last among those the store knows (the newest
// terminal event); null while nothing has finished. Its `updatedAt` is the
// time of its terminal event.
export const selectLatestFinishedThread = createSelector([selectThreadsById], byId => {
  let latest: Thread | null = null;

  for (const thread of Object.values(byId)) {
    if (thread.terminalSeq !== null && (latest === null || latest.terminalSeq === null || thread.terminalSeq > latest.terminalSeq)) {
      latest = thread;
    }
  }

  return latest;
});

export function matchesFilters(thread: Thread, filters: ThreadsListFilters): boolean {
  return (filters.status === null || thread.status === filters.status) && (filters.projectId === null || thread.projectId === filters.projectId);
}

// Whether a page of the current filter set has landed. Rows in `ids` say so;
// without them the request state decides: an empty first page (the set has
// no threads at all) leaves the list quiet with no error, while a request
// still in flight or one that failed before any page came has not covered
// any range yet. (The server returns a cursor only with a full page, so an
// empty `ids` never comes with a cursor.)
export function hasLoadedPage(list: ThreadsListState): boolean {
  return list.filters !== null && (list.ids.length > 0 || (!list.loading && list.error === null));
}

// The rows of the threads list: a projection of the store over the range
// the pages have covered. The pages fix the floor — the oldest createdSeq
// loaded (none once the cursor is exhausted); every thread the store knows
// above it that matches the filters is a row, newest first. So a thread the
// tail started appears at the top, one that finished moves between the
// status filters, and a page never has to be refetched. Before the first
// page lands — or when it failed — there are no rows (the screen shows the
// skeleton or the error).
export const selectListThreads = createSelector([selectThreadsById, selectThreadsList], (byId, list): Thread[] => {
  if (list.filters === null || !hasLoadedPage(list)) {
    return [];
  }

  const { filters } = list;
  let floor: bigint | null = null;

  for (const id of list.ids) {
    const seq = byId[id]?.createdSeq;

    if (seq !== undefined && (floor === null || seq < floor)) {
      floor = seq;
    }
  }

  // A full page whose cursor points further back: the range ends at the
  // oldest row loaded. An exhausted cursor opens the range all the way down.
  const bound = list.nextCursor === null ? null : floor;

  return Object.values(byId)
    .filter(thread => matchesFilters(thread, filters) && (bound === null || thread.createdSeq >= bound))
    .sort(newestFirst);
});

// The text of a thread the search looks through: title, description, summary.
export function threadMatches(thread: Thread, q: string): boolean {
  const needle = q.trim().toLowerCase();

  if (!needle) {
    return true;
  }

  return [thread.title, thread.description, thread.summary?.text].some(text => text?.toLowerCase().includes(needle));
}

// The rows the Threads screen shows: the list range narrowed by the route's
// agent and search — browser-side, over the loaded rows (the server filters
// by status and project only).
export const selectVisibleListThreads = createSelector(
  [selectListThreads, (state: State) => (state.router.route.key === 'threads' ? state.router.route.agent : undefined), (state: State) => (state.router.route.key === 'threads' ? state.router.route.q : undefined)],
  (threads, agent, q) => threads.filter(thread => (!agent || thread.agent === agent) && (!q || threadMatches(thread, q))),
);

// Agents that can be picked in the list filter: the catalog plus every agent
// seen in a thread the store knows.
export const selectKnownAgents = createSelector([(state: State) => state.agents.names, selectThreadsById], (names, byId) => {
  const set = new Set(names);

  for (const thread of Object.values(byId)) {
    set.add(thread.agent);
  }

  return [...set].sort();
});

// How many threads are at work for each agent (agent name → count): the
// dot on the catalog's avatar and the "N active" badge of the Agents screen.
export const selectRunningCountByAgent = createSelector([selectRunningThreads], threads => {
  const counts: Record<string, number> = {};

  for (const thread of threads) {
    counts[thread.agent] = (counts[thread.agent] ?? 0) + 1;
  }

  return counts;
});

// The threads of one agent the store knows (the snapshot window plus the
// tail): the active ones first, then newest first — the activity of the
// agent's page. One instance per screen, memoized by the name.
export const makeSelectAgentThreads = () =>
  createSelector([selectThreadsById, (_state: State, name: string) => name], (byId, name): Thread[] =>
    Object.values(byId)
      .filter(thread => thread.agent === name)
      .sort((a, b) => {
        const liveA = a.status === 'active' ? 0 : 1;
        const liveB = b.status === 'active' ? 0 : 1;

        return liveA !== liveB ? liveA - liveB : newestFirst(a, b);
      }),
  );
