// The SDK session behind each active thread, by thread id — the fold of the
// session.* events (src/projections/session.ts), the same the snapshot
// applies server-side. A terminal of the thread drops its entry; a thread
// without an entry has no journaled session yet (the selectors derive a
// state from the thread then).

import type { SessionView } from '../../../projections/session.ts';
import { foldSession } from '../../../projections/session.ts';
import { isEventAction } from '../events.ts';
import type { Action } from '../types.ts';

export type SessionsState = Record<string, SessionView>;

export function sessionsReducer(state: SessionsState = {}, action: Action): SessionsState {
  switch (action.type) {
    case 'SNAPSHOT_LOAD_DONE':
      return { ...state, ...action.snapshot.sessions };
    default: {
      if (!isEventAction(action) || !action.event.threadId) {
        return state;
      }

      const { threadId, type, payload } = action.event;
      const current = state[threadId] ?? null;
      const next = foldSession(current, type, payload);

      if (next === current) {
        return state;
      }

      if (next === null) {
        const { [threadId]: dropped, ...rest } = state;

        return dropped ? rest : state;
      }

      return { ...state, [threadId]: next };
    }
  }
}
