import type { AppRoute } from '../../lib/router/routes.ts';

export type RouteSource = 'app' | 'history';

// `hash` — the fragment of the URL ('#part' or ''), which rides beside the
// route: no route reads it, the history process writes it into the URL
// (a link of a Markdown preview to a section of a file). `scroll` — the
// place of the body's scroll the history entry was left at, brought back
// by the history process with a popstate (null when the entry has none:
// an app navigation, an entry from before the page was loaded).
export const routeTo = (route: AppRoute, options: { replace?: boolean; source?: RouteSource; hash?: string; scroll?: number | null } = {}) =>
  ({ type: 'ROUTE_TO', route, replace: options.replace ?? false, source: options.source ?? 'app', hash: options.hash ?? '', scroll: options.scroll ?? null }) as const;

// The tab is back in view (lib/visibility): the route's data that has no
// event to keep it current is read again (router/handlers.ts).
export const tabVisible = () => ({ type: 'TAB_VISIBLE' }) as const;
