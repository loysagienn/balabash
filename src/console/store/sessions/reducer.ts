// The SDK session behind each active thread, by thread id — the fold of the
// session.* events (src/projections/session.ts), the same the snapshot
// applies server-side. A session belongs to an active thread of the store
// and to nothing else: the thread's terminal drops its entry, and a
// session.* event of a thread the store does not know as active — a late
// tail of a closed session, which the log allows — is not folded, so the
// replay equals the snapshot (readSessions reads active threads only). The
// rule needs the threads domain after the action: createStore composes this
// reducer by hand (store/index.ts). A thread without an entry has no
// journaled session yet (the selectors derive a state from the thread then).

import type { SessionView } from '../../../projections/session.ts';
import { foldSession, isSessionEvent } from '../../../projections/session.ts';
import { threadStatusFrom } from '../../../projections/thread.ts';
import { isEventAction } from '../events.ts';
import type { ThreadsState } from '../threads/reducer.ts';
import type { Action } from '../types.ts';

export type SessionsState = Record<string, SessionView>;

function without(state: SessionsState, threadId: string): SessionsState {
  const { [threadId]: dropped, ...rest } = state;

  return dropped ? rest : state;
}

export function sessionsReducer(state: SessionsState = {}, action: Action, threads: ThreadsState): SessionsState {
  switch (action.type) {
    case 'SNAPSHOT_LOAD_DONE':
      return { ...state, ...action.snapshot.sessions };
    default: {
      if (!isEventAction(action) || !action.event.threadId) {
        return state;
      }

      const { threadId, type, payload } = action.event;

      if (!isSessionEvent(type) && threadStatusFrom(type) === null) {
        return state;
      }

      if (threads.byId[threadId]?.status !== 'active') {
        return without(state, threadId);
      }

      const current = state[threadId] ?? null;
      const next = foldSession(current, type, payload);

      if (next === current) {
        return state;
      }

      return next === null ? without(state, threadId) : { ...state, [threadId]: next };
    }
  }
}
