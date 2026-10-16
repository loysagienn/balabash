// The route is state: ROUTE_TO is the only way it changes. `source` tells
// the history process whether the change came from the app (push/replace
// into history) or from history itself (popstate — nothing to write).
// ROUTE_TO from the app to the route already current (the section's own
// link, ⌘J on the main thread) with the same fragment changes nothing: the
// state keeps its identity, so the history process writes no entry and the
// shell keeps the scroll place. A ROUTE_TO from history is always a new
// state, the same URL included: a popstate is a move between two entries
// (a replace can give an entry the URL of its neighbour). The fragment of
// the URL (`hash`) rides beside the route — a new fragment of the same
// route is a new state with the same route object, so the URL gets it and
// nothing keyed by the route moves.
//
// The pages of the tab: every history entry the tab visited is a page —
// `entry` is the id the history process writes into history.state, `page`
// the screen instance that shows it (the stage keys the screens by it: a
// replace keeps the page, so does a move inside one page — the project's
// files — while a push opens a new one). `move` says how the current page
// came to be current: push (a new page forward), replace, within (a new
// entry of the same page), back / forward (a popstate between known
// entries), unknown (a popstate to an entry the tab does not know: from
// before the page was loaded, or the browser's own fragment navigation —
// it joins the pages after the current one). The stage reads the move to
// choose the transition; the "back" handler reads the pages to know
// whether the browser's back lands on the parent.

import { samePage } from '../../lib/router/nesting.ts';
import { writeRoute } from '../../lib/router/routes.ts';
import type { AppRoute } from '../../lib/router/routes.ts';
import type { Action } from '../types.ts';
import type { RouteSource } from './actions.ts';

export type NavMove = 'push' | 'replace' | 'within' | 'back' | 'forward' | 'unknown';

export type Page = { entry: number; page: number; route: AppRoute; hash: string };

export type RouterState = {
  route: AppRoute;
  source: RouteSource;
  replace: boolean;
  hash: string;
  move: NavMove;
  pages: Page[];
  // The current page: pages[index].
  index: number;
  // The next entry / page id.
  nextId: number;
};

// Two routes are the same when they say the same URL (readRoute and
// writeRoute are inverses — routes.test.ts).
export function sameRoute(a: AppRoute, b: AppRoute): boolean {
  return a === b || writeRoute(a) === writeRoute(b);
}

// The page behind the current one in the history, if the tab knows it.
export function pageBehind(state: RouterState): Page | null {
  return state.index > 0 ? state.pages[state.index - 1]! : null;
}

export const createRouterReducer =
  (initialRoute: AppRoute, initialHash = '') =>
  (
    state: RouterState = {
      route: initialRoute,
      source: 'app',
      replace: true,
      hash: initialHash,
      move: 'unknown',
      pages: [{ entry: 1, page: 1, route: initialRoute, hash: initialHash }],
      index: 0,
      nextId: 2,
    },
    action: Action,
  ): RouterState => {
    switch (action.type) {
      case 'ROUTE_TO': {
        const same = sameRoute(state.route, action.route);
        const route = same ? state.route : action.route;
        const current = state.pages[state.index]!;

        if (action.source === 'history') {
          const index = action.entry === null ? -1 : state.pages.findIndex(page => page.entry === action.entry);

          if (index >= 0) {
            const known = state.pages[index]!;
            // The page keeps its own route object while the browser brings the
            // same URL; its hash is the location's.
            const route = sameRoute(known.route, action.route) ? known.route : action.route;
            const pages =
              known.route === route && known.hash === action.hash
                ? state.pages
                : state.pages.map((page, at) => (at === index ? { ...page, route, hash: action.hash } : page));
            const move: NavMove = index < state.index ? 'back' : index > state.index ? 'forward' : 'unknown';

            return { ...state, route, source: 'history', replace: false, hash: action.hash, move, pages, index };
          }

          // An entry the tab does not know: a page of its own after the current one.
          const page: Page = { entry: state.nextId, page: state.nextId, route, hash: action.hash };
          const pages = [...state.pages.slice(0, state.index + 1), page];

          return {
            ...state,
            route,
            source: 'history',
            replace: false,
            hash: action.hash,
            move: 'unknown',
            pages,
            index: pages.length - 1,
            nextId: state.nextId + 1,
          };
        }

        if (same && state.hash === action.hash) {
          return state;
        }

        if (action.replace) {
          const page: Page = { ...current, route, hash: action.hash };
          const pages = state.pages.map((item, at) => (at === state.index ? page : item));

          return { ...state, route, source: 'app', replace: true, hash: action.hash, move: 'replace', pages };
        }

        const within = samePage(current.route, route);
        const page: Page = {
          entry: state.nextId,
          page: within ? current.page : state.nextId,
          route,
          hash: action.hash,
        };
        const pages = [...state.pages.slice(0, state.index + 1), page];
        const move: NavMove = action.back ? 'back' : within ? 'within' : 'push';

        return {
          ...state,
          route,
          source: 'app',
          replace: false,
          hash: action.hash,
          move,
          pages,
          index: pages.length - 1,
          nextId: state.nextId + 1,
        };
      }
      default:
        return state;
    }
  };
