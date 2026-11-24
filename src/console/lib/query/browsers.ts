// The linked browsers (GET /api/browsers, read under BROWSERS_KEY by
// screens/connections/queries.ts) against the store: who is connected is
// the server's memory, no event of the log carries it — but the stream says
// when the list changed (the `browsers` frame → browsers.changed,
// store/browsers/reducer.ts), and this process invalidates the query on it:
// a mounted list refetches at once, one left in the cache refetches on its
// next mount. Lives for the tab, only invalidates — a process, not a
// handler. A frame lost with a broken stream costs little: the screen reads
// the list again every half minute while it is open.

import type { QueryClient } from '@tanstack/react-query';
import type { Store } from 'redux';
import type { Action, State } from '../../store/types.ts';

export type InvalidatingQueryClient = Pick<QueryClient, 'invalidateQueries'>;

// Kept here, out of the .tsx graph, so the rule is testable under node:test.
export const BROWSERS_KEY = ['browsers'] as const;

export function connectQueryClientToBrowsers(store: Store<State, Action>, queryClient: InvalidatingQueryClient): () => void {
  let known = store.getState().browsers.changed;

  return store.subscribe(() => {
    const now = store.getState().browsers.changed;

    if (now === known) {
      return;
    }

    known = now;
    void queryClient.invalidateQueries({ queryKey: BROWSERS_KEY });
  });
}
