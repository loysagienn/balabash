import type { AppRoute } from '../../lib/router/routes.ts';

export type RouteSource = 'app' | 'history';

// `hash` — the fragment of the URL ('#part' or ''), which rides beside the
// route: no route reads it, the history process writes it into the URL
// (a link of a Markdown preview to a section of a file).
export const routeTo = (route: AppRoute, options: { replace?: boolean; source?: RouteSource; hash?: string } = {}) =>
  ({ type: 'ROUTE_TO', route, replace: options.replace ?? false, source: options.source ?? 'app', hash: options.hash ?? '' }) as const;
