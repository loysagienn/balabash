// The effect of LOAD_APPS: one listing in flight at a time; an answer that
// lands after the session ended is dropped. The server reads the listing at
// some moment of the request while the tail keeps flowing: an app.* event
// that changed the rows during the flight may be newer than the listing (a
// publish right after the scan), so the reducer leaves such an answer
// unapplied and the listing is asked for once more, from after the event.

import { toApiFailure } from '../../lib/api/index.ts';
import type { ActionHandler } from '../types.ts';
import { loadApps, loadAppsDone, loadAppsFail } from './actions.ts';

export const loadAppsHandler: ActionHandler<'LOAD_APPS'> =
  ({ api, dispatch, getState, next }) =>
  async action => {
    if (getState().apps.refresh.pending) {
      return;
    }

    next(action);

    const since = getState().apps.eventSeq;

    try {
      const apps = await api.apps.list();

      if (getState().session.status !== 'signed-in') {
        return;
      }

      dispatch(loadAppsDone(apps, since));

      if (getState().apps.eventSeq !== since) {
        dispatch(loadApps());
      }
    } catch (error) {
      if (getState().session.status !== 'signed-in') {
        return;
      }

      dispatch(loadAppsFail(toApiFailure(error)));
    }
  };
