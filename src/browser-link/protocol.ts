// The wire between a user's browser (the extension, src/browser-extension)
// and the server. Shared by both sides, types only — nothing here touches
// node or chrome.
//
// Two kinds of WebSocket, both opened by the extension:
//
// - the control link — one per browser, kept open: the extension names
//   itself (`hello`), then answers the server's requests (the list of tabs,
//   opening a session, handing a tab to a session) and pings;
// - a session link — one per agent run, opened by the extension on the
//   server's request with the one-time ticket the request carried. It speaks
//   the protocol of the Playwright extension unchanged (commands
//   `chrome.debugger.*` / `chrome.tabs.*`, events `chrome.*` and
//   `extension.initialized`), so the server side stays the model Playwright
//   itself connects to.
//
// Every frame is one JSON object. A request carries `id`, its answer the
// same `id` with `result` or `error` (a string); a frame without `id` is an
// event.

export const CONTROL_PATH = '/browser-link/control';
export const SESSION_PATH = '/browser-link/session';

// The first frame of the control link. The server answers `welcome` or
// closes the socket (CLOSE_UNAUTHORIZED).
export type HelloParams = {
  token: string;
  // The name the user gave this browser.
  name: string;
  extensionVersion: string;
};

export const CLOSE_UNAUTHORIZED = 4401;

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

export type ControlRequests = {
  'tabs.list': { params: Record<string, never>; result: { tabs: BrowserTab[] } };
  // The extension opens a session link with the ticket, gives the session a
  // blank tab of its own and answers once the link is initialized.
  'session.open': { params: { ticket: string; clientName: string }; result: { sessionId: number } };
  // Hands an existing tab of the user to a session.
  'session.claim': { params: { sessionId: number; tabId: number }; result: Record<string, never> };
};

export type ControlMethod = keyof ControlRequests;

export type Frame = {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: string;
};
