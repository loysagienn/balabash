import type { MeResponse, NamesView, SettingsPatchRequest } from '../../../api/contract.ts';
import type { ApiFailure } from '../../lib/api/index.ts';
import type { Action } from '../types.ts';

export type SessionStatus = 'loading' | 'anonymous' | 'signed-in' | 'error';

// What the sign-in form waits for: the code's check, or the server
// printing a code into its log. The request is the identity of the one
// call in flight: an answer — a session, a printed code, a failure — is
// applied only while the store still waits for exactly that request (the
// rule of the threads and apps domains), so a call that outlived a lost
// session, and the form reset with it, neither unblocks nor words the form
// of the request sent after.
export type LoginRequestKind = 'sign-in' | 'console-code';
export type LoginRequest = { kind: LoginRequestKind };

export type LoginState = {
  request: LoginRequest | null;
  error: ApiFailure | null;
  // The server has printed a code into its log (the word "console" was
  // sent): the field says where to read it until the next attempt.
  codePrinted: boolean;
};

export type SessionState = {
  status: SessionStatus;
  me: MeResponse | null;
  // The failure of the session check itself (network, 5xx) — retryable.
  error: ApiFailure | null;
  login: LoginState;
  logoutPending: boolean;
  // The names of Settings in flight, by field: the card of a field saving
  // is busy, the other card is not.
  settingsSaving: SettingsSaving;
  // How many saves of each field the server accepted: the card drops the
  // draft it sent when the count moves (a failed save leaves the draft).
  settingsSaved: SettingsSaved;
};

export type SettingsField = keyof SettingsPatchRequest;
export type SettingsSaving = Record<SettingsField, boolean>;
export type SettingsSaved = Record<SettingsField, number>;

export const SETTINGS_FIELDS: readonly SettingsField[] = ['workspaceName', 'operatorName'];

export function patchFields(patch: SettingsPatchRequest): SettingsField[] {
  return SETTINGS_FIELDS.filter(field => patch[field] !== undefined);
}

function withSaving(state: SessionState, patch: SettingsPatchRequest, saving: boolean): SettingsSaving {
  const next = { ...state.settingsSaving };

  for (const field of patchFields(patch)) {
    next[field] = saving;
  }

  return next;
}

// The answer carries both names, but the cards save on their own: only the
// fields of this patch are taken, so a late answer of one card never puts
// back the other card's name saved meanwhile.
function withSaved(state: SessionState, patch: SettingsPatchRequest, settings: NamesView): Pick<SessionState, 'me' | 'settingsSaved'> {
  const me = state.me ? { ...state.me } : null;
  const saved = { ...state.settingsSaved };

  for (const field of patchFields(patch)) {
    if (me) {
      me[field] = settings[field];
    }

    saved[field] += 1;
  }

  return { me, settingsSaved: saved };
}

export const initialSession: SessionState = {
  status: 'loading',
  me: null,
  error: null,
  login: { request: null, error: null, codePrinted: false },
  logoutPending: false,
  settingsSaving: { workspaceName: false, operatorName: false },
  settingsSaved: { workspaceName: 0, operatorName: 0 },
};

export function sessionReducer(state: SessionState = initialSession, action: Action): SessionState {
  switch (action.type) {
    case 'SESSION_CHECK':
      return { ...state, status: 'loading', error: null };
    case 'SESSION_CHECK_DONE':
      return action.me ? { ...state, status: 'signed-in', me: action.me, error: null } : { ...state, status: 'anonymous', me: null, error: null };
    case 'SESSION_CHECK_FAIL':
      return { ...state, status: 'error', me: null, error: action.error };
    case 'LOGIN':
      // The hint stays through a code's check: a mistyped code is still in
      // the log.
      return { ...state, login: { ...state.login, request: { kind: 'sign-in' }, error: null } };
    case 'LOGIN_DONE':
      if (action.request !== state.login.request) {
        return state;
      }

      return { ...state, status: 'signed-in', me: action.me, error: null, login: { request: null, error: null, codePrinted: false } };
    case 'LOGIN_FAIL':
      return action.request === state.login.request ? { ...state, login: { ...state.login, request: null, error: action.error } } : state;
    case 'CONSOLE_CODE_REQUEST':
      return { ...state, login: { request: { kind: 'console-code' }, error: null, codePrinted: false } };
    case 'CONSOLE_CODE_DONE':
      return action.request === state.login.request ? { ...state, login: { request: null, error: null, codePrinted: true } } : state;
    case 'CONSOLE_CODE_FAIL':
      return action.request === state.login.request ? { ...state, login: { request: null, error: action.error, codePrinted: false } } : state;
    case 'LOGOUT':
      return { ...state, logoutPending: true };
    case 'LOGOUT_FAIL':
      return { ...state, logoutPending: false };
    case 'SAVE_SETTINGS':
      return { ...state, settingsSaving: withSaving(state, action.patch, true) };
    case 'SAVE_SETTINGS_DONE':
      return { ...state, ...withSaved(state, action.patch, action.settings), settingsSaving: withSaving(state, action.patch, false) };
    case 'SAVE_SETTINGS_FAIL':
      return { ...state, settingsSaving: withSaving(state, action.patch, false) };
    case 'LOGOUT_DONE':
    case 'SESSION_LOST':
      return { ...initialSession, status: 'anonymous' };
    default:
      return state;
  }
}
