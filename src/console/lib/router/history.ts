// The history process: binds the store's route to the browser history. The
// initial route and fragment are read from location when the store is
// created (main.tsx); from then on every app-originated ROUTE_TO becomes
// pushState / replaceState of the route's URL with its fragment, the route
// in history.state, and popstate dispatches ROUTE_TO back from
// history.state (or from location when the entry has none) with the
// fragment the location has. Lives for the tab, only dispatches — a
// process, not a handler.
//
// The scroll place of an entry: every entry the process writes carries an
// id (`entry` in history.state) and the body's scroll place is kept by that
// id in the process's memory — taken the moment the entry is left (an app
// navigation pushing the next one, a popstate going elsewhere) and handed
// to the ROUTE_TO of the popstate that brings the entry back (`scroll`);
// the shell restores it once the screen rendered. A replace keeps the id:
// it is the same page. The browser's own restoration is off
// (scrollRestoration 'manual'): the document does not scroll, the body
// does. The memory is the tab's: after a reload every entry starts at the
// top, as does an entry the process never wrote (the browser's own
// fragment navigation).

import type { Store } from 'redux';
import type { Action, State } from '../../store/types.ts';
import { routeTo } from '../../store/router/actions.ts';
import { readRoute, writeRoute } from './routes.ts';
import type { AppRoute } from './routes.ts';

type EntryState = { route: AppRoute; entry: string };

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

function entryFromState(state: unknown): string | null {
  if (typeof state === 'object' && state !== null && 'entry' in state) {
    const entry = (state as { entry: unknown }).entry;

    return typeof entry === 'string' ? entry : null;
  }

  return null;
}

// The URL of an entry: the route's, with the fragment that rides beside it.
export function urlOf(route: AppRoute, hash: string): string {
  return `${writeRoute(route)}${hash}`;
}

export type HistoryOptions = {
  // The body's scroll place at this moment — what an entry keeps when it is
  // left; null when there is no body to read (no shell on the screen).
  readScroll?: () => number | null;
};

function newEntry(): string {
  return crypto.randomUUID();
}

export function connectStoreToHistory(store: Store<State, Action>, options: HistoryOptions = {}): () => void {
  const readScroll = options.readScroll ?? (() => null);
  const places = new Map<string, number>();
  let known = store.getState().router;
  // The entry the tab is on; null for an entry the process did not write.
  let current: string | null = newEntry();

  if ('scrollRestoration' in window.history) {
    window.history.scrollRestoration = 'manual';
  }

  // The first entry gets its route too, so a popstate back to it restores it.
  window.history.replaceState({ route: known.route, entry: current } satisfies EntryState, '', urlOf(known.route, known.hash));

  const leave = () => {
    const place = current === null ? null : readScroll();

    if (current !== null && place !== null) {
      places.set(current, place);
    }
  };

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
      current = current ?? newEntry();
      window.history.replaceState({ route, entry: current } satisfies EntryState, '', url);
    } else {
      leave();
      current = newEntry();
      window.history.pushState({ route, entry: current } satisfies EntryState, '', url);
    }
  });

  const onPopState = (event: PopStateEvent) => {
    leave();
    current = entryFromState(event.state);

    const scroll = current === null ? null : (places.get(current) ?? null);

    store.dispatch(routeTo(routeFromState(event.state) ?? routeFromLocation(), { source: 'history', hash: window.location.hash, scroll }));
  };

  window.addEventListener('popstate', onPopState);

  return () => {
    unsubscribe();
    window.removeEventListener('popstate', onPopState);
  };
}
