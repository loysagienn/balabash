// The history process: binds the store's route to the browser history. The
// initial route and fragment are read from location when the store is
// created (main.tsx); from then on every app-originated ROUTE_TO becomes
// pushState / replaceState of the route's URL with its fragment, the route
// and the entry's id (store/router: `pages`) in history.state, and
// popstate dispatches ROUTE_TO back from history.state (or from location
// when the entry has none) with the fragment the location has and the id
// of the entry — the reducer finds the page it belongs to. An entry the
// process did not write (the browser's own fragment navigation, an entry
// from before the page was loaded) has no id the tab knows: the reducer
// gives it a page of its own, and the process stamps the new id into the
// entry, so the next return to it is a known move. The ids are the
// store's counters and start over with every load of the page, so every
// entry is stamped with the id of the load that wrote it: an entry of an
// earlier load (the pages visited before a reload) is one the tab does
// not know, whatever number it carries. The browser's own
// scroll restoration is off (scrollRestoration 'manual'): the document
// does not scroll, the body does — the stage keeps the places by entry.
// Lives for the tab, only dispatches — a process, not a handler.

import type { Store } from 'redux';
import type { Action, State } from '../../store/types.ts';
import { routeTo } from '../../store/router/actions.ts';
import { readRoute, writeRoute } from './routes.ts';
import type { AppRoute } from './routes.ts';

type EntryState = { route: AppRoute; entry: number; load: string };

// The id of this load of the page.
const load = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

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

// The id of the entry when this load wrote it; null for any other entry.
function entryFromState(state: unknown): number | null {
  if (typeof state === 'object' && state !== null && 'entry' in state && 'load' in state) {
    const { entry, load: by } = state as { entry: unknown; load: unknown };

    return typeof entry === 'number' && by === load ? entry : null;
  }

  return null;
}

// The URL of an entry: the route's, with the fragment that rides beside it.
export function urlOf(route: AppRoute, hash: string): string {
  return `${writeRoute(route)}${hash}`;
}

export function connectStoreToHistory(store: Store<State, Action>): () => void {
  let known = store.getState().router;

  if ('scrollRestoration' in window.history) {
    window.history.scrollRestoration = 'manual';
  }

  const current = () => known.pages[known.index]!;

  // The first entry gets its route and id too, so a popstate back to it is a known move.
  window.history.replaceState(
    { route: known.route, entry: current().entry, load } satisfies EntryState,
    '',
    urlOf(known.route, known.hash),
  );

  const unsubscribe = store.subscribe(() => {
    const router = store.getState().router;

    if (router === known) {
      return;
    }

    known = router;

    const { route, hash } = router;
    const state: EntryState = { route, entry: current().entry, load };
    const url = urlOf(route, hash);

    if (router.source === 'history') {
      // A known entry needs nothing; one the tab did not know gets its id.
      if (router.move === 'unknown') {
        window.history.replaceState(state, '', url);
      }

      return;
    }

    if (router.replace) {
      window.history.replaceState(state, '', url);
    } else {
      window.history.pushState(state, '', url);
    }
  });

  const onPopState = (event: PopStateEvent) => {
    store.dispatch(
      routeTo(routeFromState(event.state) ?? routeFromLocation(), {
        source: 'history',
        hash: window.location.hash,
        entry: entryFromState(event.state),
      }),
    );
  };

  window.addEventListener('popstate', onPopState);

  return () => {
    unsubscribe();
    window.removeEventListener('popstate', onPopState);
  };
}
