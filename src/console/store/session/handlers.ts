// Session effects: the check at tab start, sign-in with a one-time code,
// sign-out. A signed-in outcome cascades into SNAPSHOT_LOAD (the store
// hydrates, the stream process opens the tail).

import { toApiFailure } from '../../lib/api/index.ts';
import type { ActionHandler } from '../types.ts';
import { snapshotLoad } from '../stream/actions.ts';
import { loginDone, loginFail, logoutDone, logoutFail, sessionCheckDone, sessionCheckFail } from './actions.ts';

export const sessionCheckHandler: ActionHandler<'SESSION_CHECK'> =
  ({ api, dispatch, next }) =>
  async action => {
    next(action);

    try {
      dispatch(sessionCheckDone(await api.me()));
    } catch (error) {
      const failure = toApiFailure(error);

      dispatch(failure.status === 401 ? sessionCheckDone(null) : sessionCheckFail(failure));
    }
  };

export const sessionCheckDoneHandler: ActionHandler<'SESSION_CHECK_DONE'> =
  ({ dispatch, next }) =>
  action => {
    next(action);

    if (action.me) {
      dispatch(snapshotLoad());
    }
  };

export const loginHandler: ActionHandler<'LOGIN'> =
  ({ api, dispatch, getState, next }) =>
  async action => {
    if (getState().session.login.pending) {
      return;
    }

    next(action);

    try {
      dispatch(loginDone(await api.auth(action.code)));
    } catch (error) {
      dispatch(loginFail(toApiFailure(error)));
    }
  };

export const loginDoneHandler: ActionHandler<'LOGIN_DONE'> =
  ({ dispatch, next }) =>
  action => {
    next(action);
    dispatch(snapshotLoad());
  };

export const logoutHandler: ActionHandler<'LOGOUT'> =
  ({ api, dispatch, next }) =>
  async action => {
    next(action);

    try {
      await api.logout();
      dispatch(logoutDone());
    } catch (error) {
      const failure = toApiFailure(error);

      // Already signed out on the server: the outcome is the same.
      dispatch(failure.status === 401 ? logoutDone() : logoutFail(failure));
    }
  };
