import { createSelector } from 'reselect';
import type { Event } from '../../../core/contract.ts';
import type { State } from '../types.ts';

export const selectSystemLog = (state: State) => state.system.log;
export const selectRestartsChanged = (state: State) => state.system.restartsChanged;

// The seq of the newest completion the log holds — a request after it is
// still in the way (the boot sweep completes every request before it).
export function lastCompletedSeq(log: readonly Event[]): bigint | null {
  for (let i = log.length - 1; i >= 0; i -= 1) {
    if (log[i].type === 'system.restart.completed') {
      return log[i].seq;
    }
  }

  return null;
}

// The newest restart request not completed yet, or null.
export function pendingRestartOf(log: readonly Event[]): Event | null {
  const completed = lastCompletedSeq(log);

  for (let i = log.length - 1; i >= 0; i -= 1) {
    const event = log[i];

    if (event.type === 'system.restart.completed' || (completed !== null && event.seq <= completed)) {
      break;
    }

    if (event.type === 'system.restart.requested') {
      return event;
    }
  }

  return null;
}

export const selectPendingRestart = createSelector([selectSystemLog], pendingRestartOf);
