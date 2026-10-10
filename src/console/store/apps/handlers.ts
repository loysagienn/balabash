// The effect of LOAD_APPS: one listing in flight at a time — the request the
// reducer put into apps.refresh.request — and an answer is dispatched only
// while the store still waits for exactly that request (the same rule as the
// threads handlers): after a sign-out, a lost session or the next sign-in
// the request is another one or none, and the old answer — a listing or a
// failure — is dropped without touching the rows or the new request. The
// server reads the listing at some moment of the request while the tail
// keeps flowing: an app.* event that arrived during the flight may be newer
// than the listing (a publish right after the scan), so the reducer leaves
// such an answer unapplied and the listing is asked for once more, from
// after the event.

import { toApiFailure } from '../../lib/api/index.ts';
import type { ActionHandler } from '../types.ts';
import { loadApps, loadAppsDone, loadAppsFail } from './actions.ts';

export const loadAppsHandler: ActionHandler<'LOAD_APPS'> =
  ({ api, dispatch, getState, next }) =>
  async action => {
    if (getState().apps.refresh.request) {
      return;
    }

    next(action);

    const request = getState().apps.refresh.request;

    if (!request) {
      return;
    }

    try {
      const apps = await api.apps.list();

      if (getState().apps.refresh.request !== request) {
        return;
      }

      dispatch(loadAppsDone(request, apps));

      if (getState().apps.eventSeq !== request.since) {
        dispatch(loadApps());
      }
    } catch (error) {
      if (getState().apps.refresh.request !== request) {
        return;
      }

      dispatch(loadAppsFail(request, toApiFailure(error)));
    }
  };
