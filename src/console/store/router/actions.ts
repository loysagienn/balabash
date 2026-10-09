import type { AppRoute } from '../../lib/router/routes.ts';

export type RouteSource = 'app' | 'history';

export const routeTo = (route: AppRoute, options: { replace?: boolean; source?: RouteSource } = {}) =>
  ({ type: 'ROUTE_TO', route, replace: options.replace ?? false, source: options.source ?? 'app' }) as const;
