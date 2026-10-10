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
  // Where the names of `me` stand against the log: null after /me (a plain
  // read, no position), then the snapshot's stamp, the seq of the newest
  // settings.updated folded, the seq of the event a save's answer reports.
  // Every source of names carries its position and names are taken only
  // from a position ahead of the one held — so a snapshot answering late
  // (a Retry), or the answer of a save that lagged behind another tab's
  // later save and its event, cannot put an older name back.
  namesSeq: bigint | null;
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

// A position ahead of the one held: the names it carries are newer than
// the names of `me`. Nothing held yet (null) — anything is ahead; a source
// without a position (an answer that changed nothing) is ahead of nothing.
function ahead(seq: bigint | null, held: bigint | null, orEqual = false): boolean {
  if (seq === null) {
    return false;
  }

  return held === null || (orEqual ? seq >= held : seq > held);
}

// The answer carries both names as the row had them at its event: taken
// as a whole when that event is ahead of the names held, else left — a
// late answer of one card never puts back the other card's name saved
// meanwhile, nor a name another tab saved after. The count of the saved
// fields moves either way: the save did land.
function withSaved(state: SessionState, patch: SettingsPatchRequest, settings: NamesView, seq: bigint | null): Pick<SessionState, 'me' | 'settingsSaved' | 'namesSeq'> {
  const saved = { ...state.settingsSaved };

  for (const field of patchFields(patch)) {
    saved[field] += 1;
  }

  if (!state.me || !ahead(seq, state.namesSeq)) {
    return { me: state.me, settingsSaved: saved, namesSeq: state.namesSeq };
  }

  return { me: { ...state.me, ...settings }, settingsSaved: saved, namesSeq: seq };
}

export const initialSession: SessionState = {
  status: 'loading',
  me: null,
  error: null,
  login: { request: null, error: null, codePrinted: false },
  logoutPending: false,
  settingsSaving: { workspaceName: false, operatorName: false },
  settingsSaved: { workspaceName: 0, operatorName: 0 },
  namesSeq: null,
};

export function sessionReducer(state: SessionState = initialSession, action: Action): SessionState {
  switch (action.type) {
    case 'SESSION_CHECK':
      return { ...state, status: 'loading', error: null };
    case 'SESSION_CHECK_DONE':
      return action.me ? { ...state, status: 'signed-in', me: action.me, namesSeq: null, error: null } : { ...state, status: 'anonymous', me: null, namesSeq: null, error: null };
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

      return { ...state, status: 'signed-in', me: action.me, namesSeq: null, error: null, login: { request: null, error: null, codePrinted: false } };
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
      return { ...state, ...withSaved(state, action.patch, action.settings, action.seq), settingsSaving: withSaving(state, action.patch, false) };
    case 'SAVE_SETTINGS_FAIL':
      return { ...state, settingsSaving: withSaving(state, action.patch, false) };
    case 'SNAPSHOT_LOAD_DONE': {
      // `me` of the snapshot is read after its stamp, so its names are at
      // least as of asOfSeq — a change between /me and the stamp is here
      // and the tail from the stamp will not bring it. Taken whole when the
      // stamp is at or ahead of the names held; a snapshot stamped behind
      // them (a Retry answering late) keeps the names, the tail from its
      // stamp brings their event again. Nobody signed in — nothing to do.
      if (!state.me) {
        return state;
      }

      const { asOfSeq, me } = action.snapshot;

      if (!ahead(asOfSeq, state.namesSeq, true)) {
        return { ...state, me: { ...me, workspaceName: state.me.workspaceName, operatorName: state.me.operatorName } };
      }

      return { ...state, me, namesSeq: asOfSeq };
    }
    case 'event/settings.updated': {
      // The names changed — here, in another tab or on another device: the
      // event carries the effective names as a whole, `me` takes them (a
      // card with a draft keeps it; one without follows) when the event is
      // ahead of the names held — the own save's answer may have brought
      // the same names first. Nobody signed in — nothing to update.
      if (!state.me || !ahead(action.event.seq, state.namesSeq)) {
        return state;
      }

      const { workspaceName, operatorName } = action.event.payload;

      return { ...state, me: { ...state.me, workspaceName: workspaceName ?? null, operatorName: operatorName ?? null }, namesSeq: action.event.seq };
    }
    case 'LOGOUT_DONE':
    case 'SESSION_LOST':
      return { ...initialSession, status: 'anonymous' };
    default:
      return state;
  }
}
