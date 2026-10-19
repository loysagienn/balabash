import type { MeResponse, NamesView, UserView } from '../../../api/contract.ts';
import type { ApiFailure } from '../../lib/api/index.ts';
import type { LoginRequest } from './reducer.ts';

export const sessionCheck = () => ({ type: 'SESSION_CHECK' }) as const;
// me = null: no session on this host (anonymous).
export const sessionCheckDone = (me: MeResponse | null) => ({ type: 'SESSION_CHECK_DONE', me }) as const;
export const sessionCheckFail = (error: ApiFailure) => ({ type: 'SESSION_CHECK_FAIL', error }) as const;

// An answer names the request it answers (session.login.request at the
// time of the call): the reducer applies it only while that request is
// still the one in flight.
export const login = (code: string) => ({ type: 'LOGIN', code }) as const;
export const loginDone = (request: LoginRequest | null, me: MeResponse) => ({ type: 'LOGIN_DONE', request, me }) as const;
export const loginFail = (request: LoginRequest | null, error: ApiFailure) => ({ type: 'LOGIN_FAIL', request, error }) as const;

// The word "console" in the code field: the server prints a one-time code
// into its own log (POST /api/auth/console-code, 204) — the way in without
// any channel; DONE carries no code, it never crosses the wire.
export const requestConsoleCode = () => ({ type: 'CONSOLE_CODE_REQUEST' }) as const;
export const consoleCodeDone = (request: LoginRequest | null) => ({ type: 'CONSOLE_CODE_DONE', request }) as const;
export const consoleCodeFail = (request: LoginRequest | null, error: ApiFailure) => ({ type: 'CONSOLE_CODE_FAIL', request, error }) as const;

export const logout = () => ({ type: 'LOGOUT' }) as const;
export const logoutDone = () => ({ type: 'LOGOUT_DONE' }) as const;
// Signed out of the tab's workspace while others stay signed in on this
// browser (signedIn, in order) — or the tab's workspace was already gone
// (null): the tab leaves for another workspace (lib/workspace/process.ts).
export const leaveWorkspace = (signedIn: string[] | null) => ({ type: 'WORKSPACE_LEAVE', signedIn }) as const;
export const logoutFail = (error: ApiFailure) => ({ type: 'LOGOUT_FAIL', error }) as const;

// The names of Settings (the workspace's, yours): each card saves on its
// own, the answer updates `me` — the sidebar, the feed and the cards
// follow. The workspace's name goes to PATCH /api/settings and DONE
// carries where the answer stands in the log (the seq of the
// settings.updated it journaled; null when the server changed nothing):
// the reducer takes it only ahead of the names it already holds. Your
// name goes to PATCH /api/user — a fact of the user, not of the workspace's
// log: DONE carries the user as the server now words them.
export type NamesPatch = { workspaceName?: string | null; displayName?: string | null };
export type NamesSaved = { kind: 'settings'; settings: NamesView; seq: bigint | null } | { kind: 'user'; user: UserView };

export const saveSettings = (patch: NamesPatch) => ({ type: 'SAVE_SETTINGS', patch }) as const;
export const saveSettingsDone = (patch: NamesPatch, saved: NamesSaved) => ({ type: 'SAVE_SETTINGS_DONE', patch, saved }) as const;
export const saveSettingsFail = (patch: NamesPatch, error: ApiFailure) => ({ type: 'SAVE_SETTINGS_FAIL', patch, error }) as const;

// A session-gated call answered 401: the session is gone.
export const sessionLost = () => ({ type: 'SESSION_LOST' }) as const;
