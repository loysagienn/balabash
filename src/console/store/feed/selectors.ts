import { createSelector } from 'reselect';
import type { Event } from '../../../core/contract.ts';
import type { State } from '../types.ts';
import { emptyFeed } from './reducer.ts';

export const selectThreadFeed = (state: State, threadId: string) => state.feed.byThread[threadId] ?? emptyFeed;
export const selectFeedEvents = (state: State) => state.feed.events;

// The events of a thread in seq order; memoised per thread on the seq list.
export const makeSelectThreadEvents = () =>
  createSelector([(state: State, threadId: string) => selectThreadFeed(state, threadId).seqs, selectFeedEvents], (seqs, events) =>
    seqs.map(seq => events[seq]).filter((event): event is Event => event !== undefined),
  );
