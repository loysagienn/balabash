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

import type { AppRoute } from '../../lib/router/routes.ts';
import type { ActionHandler, Dispatch, State } from '../types.ts';
import { loadApps } from '../apps/actions.ts';
import { loadThread, loadThreadEvents, loadThreads } from '../threads/actions.ts';
import { threadsFiltersOf, sameFilters } from '../threads/filters.ts';

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
