import type { AppRoute } from '../../lib/router/routes.ts';

export type RouteSource = 'app' | 'history';

// `hash` — the fragment of the URL ('#part' or ''), which rides beside the
// route: no route reads it, the history process writes it into the URL
// (a link of a Markdown preview to a section of a file).
export const routeTo = (route: AppRoute, options: { replace?: boolean; source?: RouteSource; hash?: string } = {}) =>
  ({ type: 'ROUTE_TO', route, replace: options.replace ?? false, source: options.source ?? 'app', hash: options.hash ?? '' }) as const;

// The tab is back in view (lib/visibility): the route's data that has no
// event to keep it current is read again (router/handlers.ts).
export const tabVisible = () => ({ type: 'TAB_VISIBLE' }) as const;
