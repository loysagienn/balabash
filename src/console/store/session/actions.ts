import type { MeResponse } from '../../../api/contract.ts';
import type { ApiFailure } from '../../lib/api/index.ts';

export const sessionCheck = () => ({ type: 'SESSION_CHECK' }) as const;
// me = null: no session on this host (anonymous).
export const sessionCheckDone = (me: MeResponse | null) => ({ type: 'SESSION_CHECK_DONE', me }) as const;
export const sessionCheckFail = (error: ApiFailure) => ({ type: 'SESSION_CHECK_FAIL', error }) as const;

export const login = (code: string) => ({ type: 'LOGIN', code }) as const;
export const loginDone = (me: MeResponse) => ({ type: 'LOGIN_DONE', me }) as const;
export const loginFail = (error: ApiFailure) => ({ type: 'LOGIN_FAIL', error }) as const;

export const logout = () => ({ type: 'LOGOUT' }) as const;
export const logoutDone = () => ({ type: 'LOGOUT_DONE' }) as const;
export const logoutFail = (error: ApiFailure) => ({ type: 'LOGOUT_FAIL', error }) as const;

// A session-gated call answered 401: the session is gone.
export const sessionLost = () => ({ type: 'SESSION_LOST' }) as const;
