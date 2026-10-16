import type { AppRoute } from '../../lib/router/routes.ts';

export type RouteSource = 'app' | 'history';

// `hash` — the fragment of the URL ('#part' or ''), which rides beside the
// route: no route reads it, the history process writes it into the URL
// (a link of a Markdown preview to a section of a file). `entry` — with a
// popstate, the id of the history entry the browser moved to (the process
// wrote it into history.state; null for an entry it did not write: the
// browser's own fragment navigation, an entry from before the page was
// loaded). `back` — the app's own "back": the parent page is pushed, but
// the move is a step back (the stage slides the page out, not in).
export const routeTo = (
  route: AppRoute,
  options: { replace?: boolean; source?: RouteSource; hash?: string; entry?: number | null; back?: boolean } = {},
) =>
  ({
    type: 'ROUTE_TO',
    route,
    replace: options.replace ?? false,
    source: options.source ?? 'app',
    hash: options.hash ?? '',
    entry: options.entry ?? null,
    back: options.back ?? false,
  }) as const;

// "Back" from a nested page (the header's arrow, the swipe): to the history
// entry behind this one when it is the page's parent — the browser goes
// back, the place of the parent's scroll comes back with it — and to
// `fallback` (the parent) as a new entry otherwise (store/router/handlers).
export const goBack = (fallback: AppRoute) => ({ type: 'GO_BACK', fallback }) as const;

// The tab is back in view (lib/visibility): the route's data that has no
// event to keep it current is read again (router/handlers.ts).
export const tabVisible = () => ({ type: 'TAB_VISIBLE' }) as const;
