// The last message of the pinned main thread from the store: the newest
// user.message or agent.message among the thread's loaded events (store/feed)
// or the one the snapshot carried (threads.mainLastMessage), whichever is
// later by seq — lastMessageOf, memoised per row on the thread's seq list and
// the kept message.

import { createSelector } from 'reselect';
import { makeSelectThreadEvents } from '../../store/feed/selectors.ts';
import type { State } from '../../store/types.ts';
import { lastMessageOf } from './lastAction.ts';

export const makeSelectLastMessage = () => createSelector([makeSelectThreadEvents(), (state: State) => state.threads.mainLastMessage], lastMessageOf);
