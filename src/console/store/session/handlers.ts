// Session effects: the check at tab start, sign-in with a one-time code,
// sign-out. A signed-in outcome cascades into SNAPSHOT_LOAD (the store
// hydrates, the stream process opens the tail).

import type { NamesView, SettingsPatchRequest } from '../../../api/contract.ts';
import { toApiFailure } from '../../lib/api/index.ts';
import type { ActionHandler } from '../types.ts';
import { snapshotLoad } from '../stream/actions.ts';
import { pushToast } from '../ui/actions.ts';
import { loginDone, loginFail, logoutDone, logoutFail, saveSettingsDone, saveSettingsFail, sessionCheckDone, sessionCheckFail } from './actions.ts';
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
      const { settings } = await api.settings.update(action.patch);

      dispatch(saveSettingsDone(action.patch, settings));
      dispatch(pushToast({ title: 'Saved', desc: savedWords(action.patch, settings), state: 'done' }));
    } catch (error) {
      const failure = toApiFailure(error);

      dispatch(saveSettingsFail(action.patch, failure));
      dispatch(pushToast({ title: 'Couldn’t save', desc: failure.message, state: 'err' }));
    }
  };
