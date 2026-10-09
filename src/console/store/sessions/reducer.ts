// SDK session state per thread (session.* events — plan, stage 4). Until
// those events exist the domain only holds what the snapshot gives: nothing.

import type { SessionView } from '../../../api/contract.ts';
import type { Action } from '../types.ts';

export type SessionsState = Record<string, SessionView>;

export function sessionsReducer(state: SessionsState = {}, action: Action): SessionsState {
  switch (action.type) {
    case 'SNAPSHOT_LOAD_DONE':
      return { ...state, ...action.snapshot.sessions };
    default:
      return state;
  }
}
