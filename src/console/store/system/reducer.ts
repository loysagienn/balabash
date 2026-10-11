// The system's own events (design: SystemScreen — "Restarts", "System
// event log"): the snapshot's systemLog — the newest KEEP system.* events
// the stream shows this workspace (its own and the installation's) — then
// the tail keeps them: system.restart.requested, system.restart.completed
// and system.exception are placed by seq, a seq already held is ignored (a
// reconnected tail overlaps), the oldest beyond KEEP leave — the same rule
// the server reads the snapshot by (src/api/snapshot.ts readSystemLog), so
// a replay of the tail equals the next snapshot. The restart in the way is
// derived (selectors): the requests after the newest completion.
// restartsChanged — a stamp moved by every completion: a new process is
// running, and the facts read by place (GET /api/system — the version, the
// uptime) are read again (lib/query/system.ts).

import type { Event } from '../../../core/contract.ts';
import type { Action } from '../types.ts';

export type SystemState = {
  log: Event[];
  restartsChanged: number;
};

export const KEEP = 50;

export const initialSystem: SystemState = { log: [], restartsChanged: 0 };

// In seq order, each seq once, the newest KEEP.
function placed(log: Event[], event: Event): Event[] | null {
  if (log.some(held => held.seq === event.seq)) {
    return null;
  }

  const at = log.findIndex(held => held.seq > event.seq);
  const next = at < 0 ? [...log, event] : [...log.slice(0, at), event, ...log.slice(at)];

  return next.length > KEEP ? next.slice(next.length - KEEP) : next;
}

export function systemReducer(state: SystemState = initialSystem, action: Action): SystemState {
  switch (action.type) {
    case 'SNAPSHOT_LOAD_DONE': {
      // A snapshot of an older server (until the app restarts) carries no
      // log: the domain starts empty and the tail fills it.
      const rows = (action.snapshot.systemLog ?? []) as Event[];
      let log: Event[] = [];

      for (const event of rows) {
        log = placed(log, event) ?? log;
      }

      return { ...state, log };
    }
    case 'event/system.restart.requested':
    case 'event/system.exception': {
      const log = placed(state.log, action.event);

      return log ? { ...state, log } : state;
    }
    case 'event/system.restart.completed': {
      const log = placed(state.log, action.event);

      return log ? { log, restartsChanged: state.restartsChanged + 1 } : state;
    }
    default:
      return state;
  }
}
