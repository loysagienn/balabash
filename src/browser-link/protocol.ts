// The wire between a user's browser (the extension, src/browser-extension)
// and the server, and the messages a page of the console sends to the
// extension. Shared by all three sides — nothing here touches node, chrome
// or the DOM.
//
// Two kinds of WebSocket, both opened by the extension:
//
// - the control link — one per browser, kept open: the extension names
//   itself (`hello`, with the secret of its pairing or with a pairing code),
//   the server answers `welcome` or closes; then the extension answers the
//   server's requests (the list of tabs, opening a session, parking it,
//   handing a tab of the user to a session), pings, tells what it did to a
//   session by the user's rules (`session.notice`) and reports what went
//   wrong inside it (`report`, text only);
// - a session link — one per agent run, opened by the extension on the
//   server's request with the one-time ticket the request carried. It speaks
//   the protocol of the Playwright extension unchanged (commands
//   `chrome.debugger.*` / `chrome.tabs.*`, events `chrome.*` and
//   `extension.initialized`), so the server side stays the model Playwright
//   itself connects to.
//
// A session whose agent is idle is parked: the server asks for it
// (`session.park`) and closes the session link, the extension takes the
// debugger off the session's tabs — Chrome's debugging bar goes with the
// last debugger — and keeps the session with its group of tabs. The session
// comes back by a `session.open` that names it (`resume`): a new session
// link, the tabs of its group its own again. A parked session lives inside
// its control link like any other: it ends when the link does, when the
// user stops it (`session.notice`), or when the server drops it
// (`session.drop`).
//
// Every frame is one JSON object. A request carries `id`, its answer the
// same `id` with `result` or with `error` (a text) and `code` (the machine
// form of the refusal); a frame without `id` is an event.

// The version of this wire. A server that does not speak the version of a
// `hello` closes the link with CLOSE_UNSUPPORTED_PROTOCOL.
export const PROTOCOL_VERSION = 1;

// The id of the extension, the same in every build: the `key` of its
// manifest (src/browser-extension/manifest.json) fixes it.
export const EXTENSION_ID = 'moadcglcgjkicomjkmccjfckhoeohhck';

export const CONTROL_PATH = '/browser-link/control';
export const SESSION_PATH = '/browser-link/session';

// The first frame of the control link: the secret of a paired browser, or
// the pairing code the console page handed over — with the secret of the
// pairing it replaces, when there was one.
export type HelloParams = { protocol: number; extensionVersion: string } & (
  | { secret: string }
  | { pairingCode: string; previousSecret?: string }
);

// The server's answer to `hello`. `secret` comes with a pairing only.
export type WelcomeParams = {
  browserId: string;
  // The name the user gave this browser in the console.
  name: string;
  // The version of the extension this installation builds.
  currentExtensionVersion: string;
  // The first version an agent works through (SESSIONS_SINCE_VERSION): an
  // older extension tells its user that it has to be updated.
  sessionsSinceVersion?: string;
  secret?: string;
};

// The secret is unknown or revoked; the pairing code is wrong or expired.
export const CLOSE_UNAUTHORIZED = 4401;
// The server does not speak the wire version of the `hello`.
export const CLOSE_UNSUPPORTED_PROTOCOL = 4426;

// How a session link ends. The side that closes it says why with the code:
// the extension — that the user stopped the session (the debugging bar of
// Chrome, the pause); the server — that the browser's access is withdrawn
// (the browser disconnected in the console or disabled in the workspace of
// the session) or, with the ordinary 1000, that the agent is done. Any other
// end is a lost link.
export const CLOSE_SESSION_STOPPED = 4000;
export const CLOSE_SESSION_REVOKED = 4001;

// The first version of the extension an agent works through: the one that
// holds every boundary a session is promised to be held to. An older
// extension still connects — its browser shows in the console as outdated,
// which is how its user learns to update it — but its tabs are not listed
// and no session is opened in it.
export const SESSIONS_SINCE_VERSION = '0.6.0';

// The `code` of the refusal to bring back a parked session the extension
// holds no more: on a link that lives, the user has stopped it.
export const SESSION_OVER = 'session_over';

export type BrowserTab = {
  id: number;
  windowId: number;
  // -1 — in no group.
  groupId: number;
  title: string;
  url: string;
  active: boolean;
  // Held by a session already.
  owned: boolean;
  // chrome:// and the like are no session's to work in.
  debuggable: boolean;
};

// Why the extension refused a request, in the `code` of its answer: the user
// switched the list of tabs off; the user declined to hand the tab over or
// did not answer in a minute; the tab went to another site while the user
// was deciding; the tab shows a site of the user's blocked list; nobody
// debugs the tab — a page of the browser itself or of an extension; the tab
// is another session's.
export type ControlRefusal = 'tabs_hidden' | 'declined' | 'no_answer' | 'tab_changed' | 'blocked_site' | 'not_debuggable' | 'owned';

// Whose session it is, as the user reads it: the name of the workspace ('' —
// it has none) and the title of the agent's thread.
export type SessionAbout = { workspace: string; thread: string };

export type ControlRequests = {
  // The tabs of blocked sites are not in the list.
  'tabs.list': { params: Record<string, never>; result: { tabs: BrowserTab[] } };
  // The extension opens a session link with the ticket, gives the session a
  // blank tab of its own and answers once the link is initialized. `label`
  // is what the user reads about the session (the workspace and the title of
  // the agent's thread) in one line; `about` — the same two apart: the
  // extension names the session's group of tabs by the thread and shows the
  // workspace beside it. With `resume` it is a parked session that comes
  // back, under the id it had: instead of a blank tab it gets the tabs that
  // are in its group now — the ones of `tabIds` first, in that order (the
  // order the client knew its tabs in), then the ones the user added — and
  // a blank tab only when the group is empty or gone.
  'session.open': {
    params: { ticket: string; clientName: string; label: string; about?: SessionAbout; resume?: { sessionId: number; tabIds: number[] } };
    result: { sessionId: number };
  };
  // The session is parked: the debugger leaves its tabs, the group of tabs
  // stays the session's. The server closes the session link on the answer.
  'session.park': { params: { sessionId: number }; result: Record<string, never> };
  // The session asks for a tab of the user. The extension asks the user in
  // a window of its own and answers once they agreed — up to a minute.
  'session.claim': { params: { sessionId: number; tabId: number }; result: Record<string, never> };
};

// What the extension did to a session by the user's rules: a tab of the
// session went to a blocked site and was taken from it; the user stopped
// the session while it was parked (one that holds a link says so by the
// close code of the link).
export type SessionNotice = { sessionId: number; kind: 'tab_blocked'; tabId: number } | { sessionId: number; kind: 'stopped' };

export type ControlMethod = keyof ControlRequests;

// Events of the server on the control link.
export type ControlEvents = {
  pong: undefined;
  // The user renamed the browser in the console.
  'browser.updated': { name: string };
  // The server is done with a parked session: its group is nobody's.
  'session.drop': { sessionId: number };
};

export type Frame = {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: string;
  code?: string;
};

// What a page of the console sends to the extension
// (`chrome.runtime.sendMessage(<extension id>, …)`); the extension answers
// the console's origin only.
// `theme` — the color theme the user chose in the console (the ids of
// src/utils/console-themes.ts): the extension keeps it and draws its own
// pages in it. The answer is `{ ok: true }`.
export type PageRequest = { type: 'status' } | { type: 'pair'; code: string } | { type: 'theme'; theme: string };

export type ExtensionState = 'unpaired' | 'paused' | 'connecting' | 'connected' | 'offline';

export type PageStatus = {
  // The version of the installed extension.
  version: string;
  state: ExtensionState;
  // The record this browser is paired with; null while it is not paired.
  browserId: string | null;
};

// Why a pairing did not happen: the server refused the code (wrong, used or
// expired); the server asks for a newer extension; the server did not
// answer.
export type PairError = 'code_rejected' | 'unsupported_protocol' | 'unreachable';

export type PagePairResult = { ok: true; browserId: string } | { ok: false; error: PairError };

// Dotted numeric versions, as the manifest of an extension carries them:
// negative when `a` is older than `b`.
export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);

  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = (left[i] || 0) - (right[i] || 0);

    if (difference !== 0) {
      return difference;
    }
  }

  return 0;
}
