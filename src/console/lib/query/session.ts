// The session boundary of the second data layer: the query client lives
// for the tab, the data in it belongs to a session. When the session ends
// — lost (SESSION_LOST: a 401 on a gated call) or left (sign-out) — the
// store resets itself (store/index.ts); this process does the same to the
// query client: every query and mutation, their in-flight calls cancelled,
// their data and variables gone. Nothing read or sent inside one session
// — a file's text, the metadata or the outcome of a secret request, the
// values a mutation carried — is kept for the next. Lives for the tab,
// only clears — a process, not a handler.

import type { QueryClient } from '@tanstack/react-query';
import type { Store } from 'redux';
import type { Action, State } from '../../store/types.ts';

export type ClearableQueryClient = Pick<QueryClient, 'clear'>;

export function connectQueryClientToSession(store: Store<State, Action>, queryClient: ClearableQueryClient): () => void {
  let signedIn = store.getState().session.status === 'signed-in';

  return store.subscribe(() => {
    const now = store.getState().session.status === 'signed-in';

    if (signedIn && !now) {
      queryClient.clear();
    }

    signedIn = now;
  });
}
