// Session state per thread, and the `data-state` of a thread for the UI
// (design-system rule 4): an active thread shows its session state — run,
// wait, act — a finished one its outcome: done, err, off. An active thread
// without a journaled session counts as waiting.

import type { Thread } from '../../../core/contract.ts';
import type { SessionView } from '../../../projections/session.ts';
import type { StateName } from '../../ui/atoms/state.ts';
import type { State } from '../types.ts';

export const selectSession = (state: State, threadId: string): SessionView | null => state.sessions[threadId] ?? null;

export function threadStateOf(thread: Thread, session: SessionView | null): StateName {
  switch (thread.status) {
    case 'completed':
      return 'done';
    case 'failed':
      return 'err';
    case 'cancelled':
      return 'off';
    default:
      return session?.state ?? 'wait';
  }
}

export const selectThreadState = (state: State, threadId: string): StateName | null => {
  const thread = state.threads.byId[threadId];

  return thread ? threadStateOf(thread, selectSession(state, threadId)) : null;
};
