// The history process: binds the store's route to the browser history. The
// initial route and fragment are read from location when the store is
// created (main.tsx); from then on every app-originated ROUTE_TO becomes
// pushState / replaceState of the route's URL with its fragment, the route
// in history.state, and popstate dispatches ROUTE_TO back from
// history.state (or from location when the entry has none) with the
// fragment the location has. Lives for the tab, only dispatches — a
// process, not a handler.

import type { Store } from 'redux';
import type { Action, State } from '../../store/types.ts';
import { routeTo } from '../../store/router/actions.ts';
import { readRoute, writeRoute } from './routes.ts';
import type { AppRoute } from './routes.ts';

function routeFromLocation(): AppRoute {
  return readRoute(window.location.pathname + window.location.search);
}

function routeFromState(state: unknown): AppRoute | null {
  if (typeof state === 'object' && state !== null && 'route' in state) {
    const route = (state as { route: unknown }).route;

    if (typeof route === 'object' && route !== null && typeof (route as AppRoute).key === 'string') {
      return route as AppRoute;
    }
  }

  return null;
}

// The URL of an entry: the route's, with the fragment that rides beside it.
export function urlOf(route: AppRoute, hash: string): string {
  return `${writeRoute(route)}${hash}`;
}

export function connectStoreToHistory(store: Store<State, Action>): () => void {
  let known = store.getState().router;

  // The first entry gets its route too, so a popstate back to it restores it.
  window.history.replaceState({ route: known.route }, '', urlOf(known.route, known.hash));

  const unsubscribe = store.subscribe(() => {
    const router = store.getState().router;

    if (router === known) {
      return;
    }

    known = router;

    if (router.source === 'history') {
      return;
    }

    const { route, hash } = router;
    const url = urlOf(route, hash);

    if (router.replace) {
      window.history.replaceState({ route }, '', url);
    } else {
      window.history.pushState({ route }, '', url);
    }
  });

  const onPopState = (event: PopStateEvent) => {
    store.dispatch(routeTo(routeFromState(event.state) ?? routeFromLocation(), { source: 'history', hash: window.location.hash }));
  };

  window.addEventListener('popstate', onPopState);

  return () => {
    unsubscribe();
    window.removeEventListener('popstate', onPopState);
  };
}
