// The form of a one-time link against the request it was read for: the
// screen secrets/<id> keeps the request's metadata in the query
// ['secret-request', id] for as long as the tab lives (staleTime Infinity —
// the row dies on fulfilment, and a form under the operator's hands must
// not refetch into "Link expired" by itself), while the store's
// secretRequests follow the log: a request issued again for the same server
// is the same id with new fields, a new thread and a new moment. Without
// this process the bell would say "asks for API_KEY and TOKEN" and Enter
// would open the form of API_KEY alone, cached before the second request —
// the POST refused for the field the form does not show, with no way out
// but a reload. So: when a request appears in the store or its moment
// changes, the query of its id is invalidated — an open form refetches at
// once and follows the new fields, a form left in the cache refetches on
// its next mount; an id the cache does not hold costs nothing. A request
// that ends ('saved', 'expired' in the cache) never shares its id with a
// new one (the row is gone, the next is a new row), so the invalidation
// only ever reaches a form. Lives for the tab, only invalidates — a
// process, not a handler.

import type { QueryClient } from '@tanstack/react-query';
import type { Store } from 'redux';
import type { OpenSecretRequestView } from '../../../api/contract.ts';
import { secretRequestKey } from '../../screens/outside/Secrets.logic.ts';
import type { Action, State } from '../../store/types.ts';

export type InvalidatingQueryClient = Pick<QueryClient, 'invalidateQueries'>;

type Requests = Record<string, OpenSecretRequestView>;

// The ids whose request is new to the store or carries a new moment: a
// row of the snapshot read again unchanged is not one.
export function reissuedRequests(before: Requests, after: Requests): string[] {
  return Object.values(after)
    .filter(request => before[request.id]?.requestedAt.getTime() !== request.requestedAt.getTime())
    .map(request => request.id);
}

export function connectQueryClientToSecretRequests(store: Store<State, Action>, queryClient: InvalidatingQueryClient): () => void {
  let known = store.getState().secretRequests.byId;

  return store.subscribe(() => {
    const now = store.getState().secretRequests.byId;

    if (now === known) {
      return;
    }

    for (const id of reissuedRequests(known, now)) {
      void queryClient.invalidateQueries({ queryKey: secretRequestKey(id) });
    }

    known = now;
  });
}
