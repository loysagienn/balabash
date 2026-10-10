// The run journal (job_runs, read by place under the keys of
// screens/schedule/queries.ts) against the store: the journal is telemetry
// outside the log, so no event carries a run — but the store does learn
// when it moved (schedule.runsChanged: a manual run of a command job
// accepted, a job that reported through the log — store/schedule/reducer.ts),
// and this process invalidates every journal query on it: a mounted list
// refetches at once and shows the new row, one left in the cache refetches
// on its next mount. Lives for the tab, only invalidates — a process, not
// a handler. A silent success writes no event and moves no stamp: the
// screen polls while a run it shows is going.

import type { QueryClient } from '@tanstack/react-query';
import type { Store } from 'redux';
import type { Action, State } from '../../store/types.ts';

export type InvalidatingQueryClient = Pick<QueryClient, 'invalidateQueries'>;

// The prefix of every query of the journal (screens/schedule/queries.ts
// builds its keys on it) — the process invalidates by it. Kept here, out of
// the .tsx graph, so the rule is testable under node:test.
export const JOB_RUNS_KEY = ['job-runs'] as const;

export function connectQueryClientToSchedule(store: Store<State, Action>, queryClient: InvalidatingQueryClient): () => void {
  let known = store.getState().schedule.runsChanged;

  return store.subscribe(() => {
    const now = store.getState().schedule.runsChanged;

    if (now === known) {
      return;
    }

    known = now;
    void queryClient.invalidateQueries({ queryKey: JOB_RUNS_KEY });
  });
}
