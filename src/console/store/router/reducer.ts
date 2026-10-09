// The route is state: ROUTE_TO is the only way it changes. `source` tells
// the history process whether the change came from the app (push/replace
// into history) or from history itself (popstate — nothing to write).
// ROUTE_TO to the route already current (the section's own link, ⌘J on
// the main thread) changes nothing: the state keeps its identity, so the
// history process writes no entry and the shell keeps the scroll place.

import { writeRoute } from '../../lib/router/routes.ts';
import type { AppRoute } from '../../lib/router/routes.ts';
import type { Action } from '../types.ts';
import type { RouteSource } from './actions.ts';

export type RouterState = {
  route: AppRoute;
  source: RouteSource;
  replace: boolean;
};

// Two routes are the same when they say the same URL (readRoute and
// writeRoute are inverses — routes.test.ts).
export function sameRoute(a: AppRoute, b: AppRoute): boolean {
  return a === b || writeRoute(a) === writeRoute(b);
}

export const createRouterReducer =
  (initialRoute: AppRoute) =>
  (state: RouterState = { route: initialRoute, source: 'app', replace: true }, action: Action): RouterState => {
    switch (action.type) {
      case 'ROUTE_TO':
        return sameRoute(state.route, action.route) ? state : { route: action.route, source: action.source, replace: action.replace };
      default:
        return state;
    }
  };
