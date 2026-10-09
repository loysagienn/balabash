import { createSelector } from 'reselect';
import type { Thread } from '../../../core/contract.ts';
import type { State } from '../types.ts';

export const selectThreadsById = (state: State) => state.threads.byId;
export const selectThreadsList = (state: State) => state.threads.list;
export const selectThread = (state: State, id: string): Thread | undefined => state.threads.byId[id];

// Agent threads at work: active threads below the root (the workspace's
// main thread is always active and is not "work in progress"). Until the
// session.* events exist (plan, stage 4) an active thread counts as running.
export const selectRunningThreads = createSelector([selectThreadsById], byId =>
  Object.values(byId)
    .filter(thread => thread.status === 'active' && thread.parentId !== null)
    .sort((a, b) => (a.createdSeq > b.createdSeq ? -1 : a.createdSeq < b.createdSeq ? 1 : 0)),
);

export const selectRunningCount = (state: State) => selectRunningThreads(state).length;

export const selectListThreads = createSelector([selectThreadsById, selectThreadsList], (byId, list) =>
  list.ids.map(id => byId[id]).filter((thread): thread is Thread => thread !== undefined),
);
