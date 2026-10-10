// Session effects: the check at tab start, sign-in with a one-time code,
// sign-out. A signed-in outcome cascades into SNAPSHOT_LOAD (the store
// hydrates, the stream process opens the tail).

import type { NamesView, SettingsPatchRequest } from '../../../api/contract.ts';
import { toApiFailure } from '../../lib/api/index.ts';
import type { ActionHandler } from '../types.ts';
import { snapshotLoad } from '../stream/actions.ts';
import { pushToast } from '../ui/actions.ts';
import { consoleCodeDone, consoleCodeFail, loginDone, loginFail, logoutDone, logoutFail, saveSettingsDone, saveSettingsFail, sessionCheckDone, sessionCheckFail } from './actions.ts';
import { patchFields } from './reducer.ts';

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

// The form waits for one thing at a time: a request while the code is
// being checked, or a code while one is being printed, is dropped. The
// answer is for the request the reducer put into session.login.request
// and is dispatched only while the store still waits for exactly it: a
// lost session (a stale 401 of the session before) resets the form while
// the call is in flight, and the answer of that call — a session, a
// printed code, a failure — must not word or unblock the form of the
// request sent after.
export const loginHandler: ActionHandler<'LOGIN'> =
  ({ api, dispatch, getState, next }) =>
  async action => {
    if (getState().session.login.request) {
      return;
    }

    next(action);

    const request = getState().session.login.request;

    if (!request) {
      return;
    }

    try {
      const me = await api.auth(action.code);

      if (getState().session.login.request === request) {
        dispatch(loginDone(request, me));
      }
    } catch (error) {
      if (getState().session.login.request === request) {
        dispatch(loginFail(request, toApiFailure(error)));
      }
    }
  };

export const consoleCodeHandler: ActionHandler<'CONSOLE_CODE_REQUEST'> =
  ({ api, dispatch, getState, next }) =>
  async action => {
    if (getState().session.login.request) {
      return;
    }

    next(action);

    const request = getState().session.login.request;

    if (!request) {
      return;
    }

    try {
      await api.consoleCode();

      if (getState().session.login.request === request) {
        dispatch(consoleCodeDone(request));
      }
    } catch (error) {
      if (getState().session.login.request === request) {
        dispatch(consoleCodeFail(request, toApiFailure(error)));
      }
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

// What the "Saved" toast says: the effective name after the save, or that
// the name is cleared. Clearing is what the patch asked for — null or a
// blank string, the form's way — not what the answer carries: a cleared
// workspace name answers the group's title.
export function savedWords(patch: SettingsPatchRequest, settings: NamesView): string {
  return patchFields(patch)
    .map(field => {
      const label = field === 'workspaceName' ? 'Workspace name' : 'Your name';
      const sent = patch[field];
      const value = settings[field];
      const cleared = sent === null || sent === undefined || sent.trim() === '' || value === null;

      return cleared ? `${label} cleared` : `${label}: “${value}”`;
    })
    .join(' · ');
}

// A card saves while no save of its field is in flight (a second press
// waits for the answer); the answer updates `me` and a toast confirms.
export const saveSettingsHandler: ActionHandler<'SAVE_SETTINGS'> =
  ({ api, dispatch, getState, next }) =>
  async action => {
    const fields = patchFields(action.patch);

    if (fields.length === 0 || fields.some(field => getState().session.settingsSaving[field])) {
      return;
    }

    next(action);

    try {
      const { settings, seq } = await api.settings.update(action.patch);

      dispatch(saveSettingsDone(action.patch, settings, seq));
      dispatch(pushToast({ title: 'Saved', desc: savedWords(action.patch, settings), state: 'done' }));
    } catch (error) {
      const failure = toApiFailure(error);

      dispatch(saveSettingsFail(action.patch, failure));
      dispatch(pushToast({ title: 'Couldn’t save', desc: failure.message, state: 'err' }));
    }
  };
