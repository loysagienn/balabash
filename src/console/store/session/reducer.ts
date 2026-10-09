import type { MeResponse, SettingsPatchRequest } from '../../../api/contract.ts';
import type { ApiFailure } from '../../lib/api/index.ts';
import type { Action } from '../types.ts';

export type SessionStatus = 'loading' | 'anonymous' | 'signed-in' | 'error';

export type SessionState = {
  status: SessionStatus;
  me: MeResponse | null;
  // The failure of the session check itself (network, 5xx) — retryable.
  error: ApiFailure | null;
  login: { pending: boolean; error: ApiFailure | null };
  logoutPending: boolean;
  // The names of Settings in flight, by field: the card of a field saving
  // is busy, the other card is not.
  settingsSaving: SettingsSaving;
};

export type SettingsField = keyof SettingsPatchRequest;
export type SettingsSaving = Record<SettingsField, boolean>;

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

export const initialSession: SessionState = {
  status: 'loading',
  me: null,
  error: null,
  login: { pending: false, error: null },
  logoutPending: false,
  settingsSaving: { workspaceName: false, operatorName: false },
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
      return { ...state, login: { pending: true, error: null } };
    case 'LOGIN_DONE':
      return { ...state, status: 'signed-in', me: action.me, error: null, login: { pending: false, error: null } };
    case 'LOGIN_FAIL':
      return { ...state, login: { pending: false, error: action.error } };
    case 'LOGOUT':
      return { ...state, logoutPending: true };
    case 'LOGOUT_FAIL':
      return { ...state, logoutPending: false };
    case 'SAVE_SETTINGS':
      return { ...state, settingsSaving: withSaving(state, action.patch, true) };
    case 'SAVE_SETTINGS_DONE':
      return { ...state, me: state.me ? { ...state.me, ...action.settings } : state.me, settingsSaving: withSaving(state, action.patch, false) };
    case 'SAVE_SETTINGS_FAIL':
      return { ...state, settingsSaving: withSaving(state, action.patch, false) };
    case 'LOGOUT_DONE':
    case 'SESSION_LOST':
      return { ...initialSession, status: 'anonymous' };
    default:
      return state;
  }
}
