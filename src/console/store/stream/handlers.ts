// The snapshot: GET /api/snapshot hydrates every domain (each reducer takes
// its part of SNAPSHOT_LOAD_DONE); once it has landed, the current route
// loads what it needs (the thread feed cursor depends on asOfSeq).

import { toApiFailure } from '../../lib/api/index.ts';
import type { ActionHandler } from '../types.ts';
import { loadRouteData } from '../router/handlers.ts';
import { snapshotLoadDone, snapshotLoadFail } from './actions.ts';

export const snapshotLoadHandler: ActionHandler<'SNAPSHOT_LOAD'> =
  ({ api, dispatch, getState, next }) =>
  async action => {
    if (getState().stream.snapshot.pending) {
      return;
    }

    next(action);

    try {
      const snapshot = await api.snapshot();

      if (getState().session.status !== 'signed-in') {
        return;
      }

      dispatch(snapshotLoadDone(snapshot));
    } catch (error) {
      dispatch(snapshotLoadFail(toApiFailure(error)));
    }
  };

export const snapshotLoadDoneHandler: ActionHandler<'SNAPSHOT_LOAD_DONE'> =
  ({ dispatch, getState, next }) =>
  action => {
    next(action);
    loadRouteData(getState().router.route, dispatch, getState, 'snapshot');
  };
