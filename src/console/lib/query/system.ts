// The facts of the system (GET /api/system, read by place under SYSTEM_KEY
// — features/system/queries.ts) against the store: a restart completed in
// the log (system.restartsChanged — store/system/reducer.ts) means a new
// process answers now — its version, its start, its sessions — so this
// process invalidates the query: a mounted reader (the shell's footer, the
// System screen) refetches at once. Lives for the tab, only invalidates —
// a process, not a handler.

import type { QueryClient } from '@tanstack/react-query';
import type { Store } from 'redux';
import type { Action, State } from '../../store/types.ts';

export type InvalidatingQueryClient = Pick<QueryClient, 'invalidateQueries'>;

export const SYSTEM_KEY = ['system'] as const;

export function connectQueryClientToSystem(store: Store<State, Action>, queryClient: InvalidatingQueryClient): () => void {
  let known = store.getState().system.restartsChanged;

  return store.subscribe(() => {
    const now = store.getState().system.restartsChanged;

    if (now === known) {
      return;
    }

    known = now;
    void queryClient.invalidateQueries({ queryKey: SYSTEM_KEY });
  });
}
