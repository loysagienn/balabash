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
//   server's requests (the list of tabs, opening a session, handing a tab
//   of the user to a session), pings, tells what it did to a session by the
//   user's rules (`session.notice`) and reports what went wrong inside it
//   (`report`, text only);
// - a session link — one per agent run, opened by the extension on the
//   server's request with the one-time ticket the request carried. It speaks
//   the protocol of the Playwright extension unchanged (commands
//   `chrome.debugger.*` / `chrome.tabs.*`, events `chrome.*` and
//   `extension.initialized`), so the server side stays the model Playwright
//   itself connects to.
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
  // chrome:// and the like cannot be attached to.
  debuggable: boolean;
};

// Why the extension refused a request, in the `code` of its answer: the user
// switched the list of tabs off; the user declined to hand the tab over or
// did not answer in a minute; the tab shows a site of the user's blocked
// list; Chrome lets nobody debug the tab; the tab is another session's.
export type ControlRefusal = 'tabs_hidden' | 'declined' | 'no_answer' | 'blocked_site' | 'not_debuggable' | 'owned';

export type ControlRequests = {
  // The tabs of blocked sites are not in the list.
  'tabs.list': { params: Record<string, never>; result: { tabs: BrowserTab[] } };
  // The extension opens a session link with the ticket, gives the session a
  // blank tab of its own and answers once the link is initialized. `label`
  // is what the user reads about the session (the workspace and the title of
  // the agent's thread).
  'session.open': { params: { ticket: string; clientName: string; label: string }; result: { sessionId: number } };
  // The session asks for a tab of the user. The extension asks the user in
  // a window of its own and answers once they agreed — up to a minute.
  'session.claim': { params: { sessionId: number; tabId: number }; result: Record<string, never> };
};

// What the extension did to a session by the user's rules: a tab of the
// session went to a blocked site and was taken from it.
export type SessionNotice = { sessionId: number; kind: 'tab_blocked'; tabId: number };

export type ControlMethod = keyof ControlRequests;

// Events of the server on the control link.
export type ControlEvents = {
  pong: undefined;
  // The user renamed the browser in the console.
  'browser.updated': { name: string };
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
export type PageRequest = { type: 'status' } | { type: 'pair'; code: string };

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
