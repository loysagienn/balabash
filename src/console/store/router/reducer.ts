// The route is state: ROUTE_TO is the only way it changes. `source` tells
// the history process whether the change came from the app (push/replace
// into history) or from history itself (popstate — nothing to write).

import type { AppRoute } from '../../lib/router/routes.ts';
import type { Action } from '../types.ts';
import type { RouteSource } from './actions.ts';

export type RouterState = {
  route: AppRoute;
  source: RouteSource;
  replace: boolean;
};

export const createRouterReducer =
  (initialRoute: AppRoute) =>
  (state: RouterState = { route: initialRoute, source: 'app', replace: true }, action: Action): RouterState => {
    switch (action.type) {
      case 'ROUTE_TO':
        return { route: action.route, source: action.source, replace: action.replace };
      default:
        return state;
    }
  };
