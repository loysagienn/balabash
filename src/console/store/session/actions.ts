import type { MeResponse, NamesView, SettingsPatchRequest } from '../../../api/contract.ts';
import type { ApiFailure } from '../../lib/api/index.ts';

export const sessionCheck = () => ({ type: 'SESSION_CHECK' }) as const;
// me = null: no session on this host (anonymous).
export const sessionCheckDone = (me: MeResponse | null) => ({ type: 'SESSION_CHECK_DONE', me }) as const;
export const sessionCheckFail = (error: ApiFailure) => ({ type: 'SESSION_CHECK_FAIL', error }) as const;

export const login = (code: string) => ({ type: 'LOGIN', code }) as const;
export const loginDone = (me: MeResponse) => ({ type: 'LOGIN_DONE', me }) as const;
export const loginFail = (error: ApiFailure) => ({ type: 'LOGIN_FAIL', error }) as const;

// The word "console" in the code field: the server prints a one-time code
// into its own log (POST /api/auth/console-code, 204) — the way in without
// any channel; DONE carries nothing, the code never crosses the wire.
export const requestConsoleCode = () => ({ type: 'CONSOLE_CODE_REQUEST' }) as const;
export const consoleCodeDone = () => ({ type: 'CONSOLE_CODE_DONE' }) as const;
export const consoleCodeFail = (error: ApiFailure) => ({ type: 'CONSOLE_CODE_FAIL', error }) as const;

export const logout = () => ({ type: 'LOGOUT' }) as const;
export const logoutDone = () => ({ type: 'LOGOUT_DONE' }) as const;
export const logoutFail = (error: ApiFailure) => ({ type: 'LOGOUT_FAIL', error }) as const;

// The names of Settings (workspace, operator): each card saves on its own,
// the answer updates `me` — the sidebar, the feed and the cards follow.
export const saveSettings = (patch: SettingsPatchRequest) => ({ type: 'SAVE_SETTINGS', patch }) as const;
export const saveSettingsDone = (patch: SettingsPatchRequest, settings: NamesView) => ({ type: 'SAVE_SETTINGS_DONE', patch, settings }) as const;
export const saveSettingsFail = (patch: SettingsPatchRequest, error: ApiFailure) => ({ type: 'SAVE_SETTINGS_FAIL', patch, error }) as const;

// A session-gated call answered 401: the session is gone.
export const sessionLost = () => ({ type: 'SESSION_LOST' }) as const;
