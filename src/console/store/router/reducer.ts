// The route is state: ROUTE_TO is the only way it changes. `source` tells
// the history process whether the change came from the app (push/replace
// into history) or from history itself (popstate — nothing to write).
// ROUTE_TO from the app to the route already current (the section's own
// link, ⌘J on the main thread) with the same fragment changes nothing: the
// state keeps its identity, so the history process writes no entry and the
// shell keeps the scroll place. A ROUTE_TO from history is always a new
// state, the same URL included: a popstate is a move between two entries
// (a replace can give an entry the URL of its neighbour), and each entry
// has its own place to bring back — the state's identity is what tells the
// shell a navigation happened. The fragment of the URL (`hash`) rides
// beside the route — a new fragment of the same route is a new state with
// the same route object, so the URL gets it and nothing keyed by the route
// moves. `scroll` — the body's scroll place a history navigation brings
// back (the shell restores it after the screen rendered); null for every
// other change, which starts its screen at the top.

import { writeRoute } from '../../lib/router/routes.ts';
import type { AppRoute } from '../../lib/router/routes.ts';
import type { Action } from '../types.ts';
import type { RouteSource } from './actions.ts';

export type RouterState = {
  route: AppRoute;
  source: RouteSource;
  replace: boolean;
  hash: string;
  scroll: number | null;
};

// Two routes are the same when they say the same URL (readRoute and
// writeRoute are inverses — routes.test.ts).
export function sameRoute(a: AppRoute, b: AppRoute): boolean {
  return a === b || writeRoute(a) === writeRoute(b);
}

export const createRouterReducer =
  (initialRoute: AppRoute, initialHash = '') =>
  (state: RouterState = { route: initialRoute, source: 'app', replace: true, hash: initialHash, scroll: null }, action: Action): RouterState => {
    switch (action.type) {
      case 'ROUTE_TO': {
        const same = sameRoute(state.route, action.route);

        if (same && state.hash === action.hash && action.source !== 'history') {
          return state;
        }

        return { route: same ? state.route : action.route, source: action.source, replace: action.replace, hash: action.hash, scroll: action.scroll };
      }
      default:
        return state;
    }
  };
