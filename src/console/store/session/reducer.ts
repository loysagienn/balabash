import type { MeResponse } from '../../../api/contract.ts';
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
};

export const initialSession: SessionState = {
  status: 'loading',
  me: null,
  error: null,
  login: { pending: false, error: null },
  logoutPending: false,
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
    case 'LOGOUT_DONE':
    case 'SESSION_LOST':
      return { ...initialSession, status: 'anonymous' };
    default:
      return state;
  }
}
