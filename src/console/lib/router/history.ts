// The history process: binds the store's route to the browser history. The
// initial route is read from location when the store is created (main.tsx);
// from then on every app-originated ROUTE_TO becomes pushState /
// replaceState with the route in history.state, and popstate dispatches
// ROUTE_TO back from history.state (or from location when the entry has
// none). Lives for the tab, only dispatches — a process, not a handler.

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

export function connectStoreToHistory(store: Store<State, Action>): () => void {
  let known = store.getState().router.route;

  // The first entry gets its route too, so a popstate back to it restores it.
  window.history.replaceState({ route: known }, '', writeRoute(known));

  const unsubscribe = store.subscribe(() => {
    const { route, source, replace } = store.getState().router;

    if (route === known) {
      return;
    }

    known = route;

    if (source === 'history') {
      return;
    }

    const url = writeRoute(route);

    if (replace) {
      window.history.replaceState({ route }, '', url);
    } else {
      window.history.pushState({ route }, '', url);
    }
  });

  const onPopState = (event: PopStateEvent) => {
    store.dispatch(routeTo(routeFromState(event.state) ?? routeFromLocation(), { source: 'history' }));
  };

  window.addEventListener('popstate', onPopState);

  return () => {
    unsubscribe();
    window.removeEventListener('popstate', onPopState);
  };
}
