// What a route needs is loaded by the ROUTE_TO handler (cascade), not by
// effects in screens: the thread screen asks for its feed, the threads list
// for its page, the Apps screen for the listing. Query-layer data (files)
// is not here. The same loading runs again when the snapshot lands
// (stream/handlers.ts), because the feed cursor and the project slugs
// depend on it, and when the tab comes back into view (TAB_VISIBLE, the
// visibility process) — the trigger tells the cases apart: what the
// snapshot has just brought is not asked for again, and a route change
// within the same section ('within' — the segment, the search, the id of
// the thread shown) is not an entry into it ('enter').
//
// GO_BACK is the one "back" of the app (the header's arrow, the swipe of a
// page): when the tab knows the history entry behind the current one — the
// page this one was opened from — the browser goes back (its popstate
// brings that page as a ROUTE_TO from history, and the stage brings its
// scroll place back); otherwise the parent (`fallback`) is pushed as a new
// entry, marked as a step back.

import type { AppRoute } from '../../lib/router/routes.ts';
import type { ActionHandler, Dispatch, State } from '../types.ts';
import { loadApps } from '../apps/actions.ts';
import { loadThread, loadThreadEvents, loadThreads } from '../threads/actions.ts';
import { draftLoad } from '../drafts/actions.ts';
import { threadsFiltersOf, sameFilters } from '../threads/filters.ts';
import { routeTo } from './actions.ts';
import { pageBehind } from './reducer.ts';
import type { RouterState } from './reducer.ts';

export type LoadTrigger = 'enter' | 'within' | 'snapshot' | 'visible';

export function loadRouteData(route: AppRoute, dispatch: Dispatch, getState: () => State, trigger: LoadTrigger): void {
  const state = getState();

  if (state.session.status !== 'signed-in' || state.stream.asOfSeq === null) {
    return;
  }

  switch (route.key) {
    case 'thread': {
      const feed = state.feed.byThread[route.id];

      // A thread outside the snapshot window is fetched by id (once; a
      // failed lookup stays until the screen retries).
      if (!state.threads.byId[route.id] && !state.threads.lookup[route.id]) {
        dispatch(loadThread(route.id));
      }

      if (!feed || (feed.knownFrom === null && !feed.exhausted && !feed.request)) {
        dispatch(loadThreadEvents(route.id, null));
      }

      // The user's draft of the thread (store/drafts): read on entering,
      // and read again on the tab's return — typed on another device
      // meanwhile; the handler leaves the tab's own unsaved edits alone.
      // The snapshot's trigger repeats the entry for the route data that
      // depends on it; the draft does not, and is already asked for.
      if (trigger !== 'snapshot' || !state.drafts.byThread[route.id]) {
        dispatch(draftLoad(route.id));
      }

      return;
    }
    case 'threads': {
      const filters = threadsFiltersOf(route, state.projects);

      // A new filter set starts its first page at once, even while a page of
      // the previous set is in flight: LOAD_THREADS retargets the list, and
      // the handler drops the answer to the old set when it lands.
      if (!sameFilters(state.threads.list.filters, filters)) {
        dispatch(loadThreads(filters, null));
      }

      return;
    }
    case 'apps': {
      // The listing has no event for a new folder or an edited manifest:
      // read again on entering the screen and on the tab's return. The
      // snapshot's rows are fresh, and the segment or the search changing
      // within the screen narrows the rows it has (visibleApps) — the
      // server's listing walks the file area and reads every manifest, not
      // a read per keystroke.
      if (trigger === 'enter' || trigger === 'visible') {
        dispatch(loadApps());
      }

      return;
    }
    default:
      return;
  }
}

export const routeToHandler: ActionHandler<'ROUTE_TO'> =
  ({ dispatch, getState, next }) =>
  action => {
    const from = getState().router.route;

    next(action);
    loadRouteData(action.route, dispatch, getState, from.key === action.route.key ? 'within' : 'enter');
  };

export const tabVisibleHandler: ActionHandler<'TAB_VISIBLE'> =
  ({ dispatch, getState, next }) =>
  action => {
    next(action);
    loadRouteData(getState().router.route, dispatch, getState, 'visible');
  };

// Whether the browser's back is the way: the entry behind the current one
// is known to the tab — the page this one was opened from (a thread opened
// from another thread goes back to that thread, not to the list). The
// parent is the way only when the tab knows nothing behind (a deep link,
// the first page after a reload).
export function backThroughHistory(router: RouterState): boolean {
  return pageBehind(router) !== null;
}

// The browser's history as the handler sees it; the test gives a stand-in.
export type BackHistory = { back(): void };

export const goBackHandler =
  (history: () => BackHistory | null): ActionHandler<'GO_BACK'> =>
  ({ dispatch, getState, next }) =>
  action => {
    next(action);

    const browser = history();

    if (browser && backThroughHistory(getState().router)) {
      browser.back();
    } else {
      dispatch(routeTo(action.fallback, { back: true }));
    }
  };
