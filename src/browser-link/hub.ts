// The server's end of the browser links: accepts the WebSockets the
// extensions open (protocol.ts), keeps the connected browsers and opens
// sessions in them.
//
// The hub owns no HTTP server: the owner of one hands it the upgrade
// requests of the two paths. Who a browser is decides `authenticate` — the
// hub only carries the token of the `hello` frame to it.
//
// A session link is admitted by its ticket alone: the ticket is random,
// lives for one use and a few seconds, and travels to the extension over
// the control link that has already been authenticated.

import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import { CLOSE_UNAUTHORIZED, CONTROL_PATH, SESSION_PATH } from './protocol.ts';
import type { BrowserTab, ControlMethod, ControlRequests, Frame, HelloParams } from './protocol.ts';

const HELLO_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 30_000;
// Silence for this long means the link is dead: the extension pings every 20 s.
const IDLE_TIMEOUT_MS = 60_000;

// Whoever `authenticate` recognized behind a token.
export type BrowserIdentity = {
  // Stable id of the browser (the row of the device).
  id: string;
};

// The session link of one agent run, in the vocabulary of the extension.
export type ExtensionSession = {
  // The id the extension knows the session by (for `claimTab`).
  id: number;
  send(method: string, params: unknown[]): Promise<unknown>;
  onEvent: ((method: string, params: unknown[]) => void) | null;
  onClose: ((reason: string) => void) | null;
  close(reason: string): void;
};

export type ConnectedBrowser = {
  identity: BrowserIdentity;
  name: string;
  extensionVersion: string;
  listTabs(): Promise<BrowserTab[]>;
  openSession(options: { clientName: string }): Promise<ExtensionSession>;
  claimTab(session: ExtensionSession, tabId: number): Promise<void>;
  // Drops the control link (the extension dials again by itself).
  disconnect(reason: string): void;
};

export type BrowserLinkHub = {
  // True when the request was one of the hub's paths and has been taken.
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean;
  browsers(): ConnectedBrowser[];
  onConnected: ((browser: ConnectedBrowser) => void) | null;
  onDisconnected: ((browser: ConnectedBrowser, reason: string) => void) | null;
  close(): void;
};

type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout };

// Requests one way, events the other, over one socket.
function createRequester(socket: WebSocket) {
  const pending = new Map<number, Pending>();
  let lastId = 0;

  return {
    request(method: string, params: unknown): Promise<unknown> {
      if (socket.readyState !== socket.OPEN) {
        return Promise.reject(new Error('The browser link is closed'));
      }

      const id = ++lastId;

      socket.send(JSON.stringify({ id, method, params }));

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`The browser did not answer ${method} in ${REQUEST_TIMEOUT_MS / 1000} s`));
        }, REQUEST_TIMEOUT_MS);

        pending.set(id, { resolve, reject, timer });
      });
    },

    // True when the frame was the answer to a request.
    settle(frame: Frame): boolean {
      const waiting = frame.id === undefined ? undefined : pending.get(frame.id);

      if (!waiting) {
        return false;
      }

      pending.delete(frame.id!);
      clearTimeout(waiting.timer);

      if (frame.error !== undefined) {
        waiting.reject(new Error(String(frame.error)));
      } else {
        waiting.resolve(frame.result);
      }

      return true;
    },

    failAll(reason: string) {
      for (const waiting of pending.values()) {
        clearTimeout(waiting.timer);
        waiting.reject(new Error(reason));
      }

      pending.clear();
    },
  };
}

function parseFrame(data: unknown): Frame | null {
  try {
    const frame: unknown = JSON.parse(String(data));

    return frame && typeof frame === 'object' && !Array.isArray(frame) ? (frame as Frame) : null;
  } catch {
    return null;
  }
}

export function createBrowserLinkHub(options: {
  authenticate(token: string): Promise<BrowserIdentity | null>;
}): BrowserLinkHub {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 * 1024 });
  const connected = new Map<string, { browser: ConnectedBrowser; socket: WebSocket }>();
  const tickets = new Map<string, { resolve(session: WebSocket): void; timer: NodeJS.Timeout }>();

  const hub: BrowserLinkHub = {
    onConnected: null,
    onDisconnected: null,
    browsers: () => [...connected.values()].map(entry => entry.browser),

    handleUpgrade(request, socket, head) {
      const url = new URL(request.url ?? '/', 'http://link');

      if (url.pathname === CONTROL_PATH) {
        sockets.handleUpgrade(request, socket, head, ws => acceptControl(ws));

        return true;
      }

      if (url.pathname === SESSION_PATH) {
        const ticket = tickets.get(url.searchParams.get('ticket') ?? '');

        if (!ticket) {
          socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');

          return true;
        }

        tickets.delete(url.searchParams.get('ticket')!);
        clearTimeout(ticket.timer);
        sockets.handleUpgrade(request, socket, head, ws => ticket.resolve(ws));

        return true;
      }

      return false;
    },

    close() {
      for (const { socket } of connected.values()) {
        socket.close(1001, 'Server is closing');
      }

      sockets.close();
    },
  };

  const waitForSessionSocket = (ticket: string): Promise<WebSocket> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        tickets.delete(ticket);
        reject(new Error('The browser did not open the session link'));
      }, REQUEST_TIMEOUT_MS);

      tickets.set(ticket, { resolve, timer });
    });

  const wrapSession = (socket: WebSocket): ExtensionSession & { initialized: Promise<void>; setId(id: number): void } => {
    const requester = createRequester(socket);
    let markInitialized!: () => void;
    let failInitialized!: (error: Error) => void;
    const initialized = new Promise<void>((resolve, reject) => {
      markInitialized = resolve;
      failInitialized = reject;
    });
    // Events that arrive before the owner listens (the first tab is announced
    // ahead of `extension.initialized`) wait for it.
    const early: Array<[string, unknown[]]> = [];
    let onEvent: ExtensionSession['onEvent'] = null;
    let id = 0;

    const session = {
      get id() {
        return id;
      },
      setId(value: number) {
        id = value;
      },
      initialized,
      send: (method: string, params: unknown[]) => requester.request(method, params),
      get onEvent() {
        return onEvent;
      },
      set onEvent(listener: ExtensionSession['onEvent']) {
        onEvent = listener;

        if (listener) {
          for (const [method, params] of early.splice(0)) {
            listener(method, params);
          }
        }
      },
      onClose: null as ExtensionSession['onClose'],
      close: (reason: string) => socket.close(1000, reason.slice(0, 100)),
    };

    socket.on('message', data => {
      const frame = parseFrame(data);

      if (!frame) {
        socket.close(1003, 'Not a JSON frame');

        return;
      }

      if (requester.settle(frame) || typeof frame.method !== 'string') {
        return;
      }

      const params = Array.isArray(frame.params) ? frame.params : [];

      if (frame.method === 'extension.initialized') {
        markInitialized();

        return;
      }

      if (onEvent) {
        onEvent(frame.method, params);
      } else {
        early.push([frame.method, params]);
      }
    });

    socket.on('close', (_code, reason) => {
      const text = reason.toString() || 'The session link closed';

      requester.failAll(text);
      failInitialized(new Error(text));
      session.onClose?.(text);
    });

    socket.on('error', error => console.warn('[browser-link] session link error:', error.message));
    initialized.catch(() => {});

    return session;
  };

  const acceptControl = (socket: WebSocket) => {
    const requester = createRequester(socket);
    let browser: ConnectedBrowser | null = null;
    let idle: NodeJS.Timeout | null = null;
    const helloTimer = setTimeout(() => socket.close(CLOSE_UNAUTHORIZED, 'No hello'), HELLO_TIMEOUT_MS);

    const touch = () => {
      if (idle) {
        clearTimeout(idle);
      }

      idle = setTimeout(() => socket.terminate(), IDLE_TIMEOUT_MS);
    };

    const request = <M extends ControlMethod>(method: M, params: ControlRequests[M]['params']) =>
      requester.request(method, params) as Promise<ControlRequests[M]['result']>;

    const admit = async (hello: Partial<HelloParams> | undefined) => {
      const identity = typeof hello?.token === 'string' ? await options.authenticate(hello.token) : null;

      clearTimeout(helloTimer);

      if (!identity) {
        socket.close(CLOSE_UNAUTHORIZED, 'Unknown token');

        return;
      }

      // The same browser dialing again replaces its previous link.
      connected.get(identity.id)?.socket.close(1000, 'Replaced by a new link');

      browser = {
        identity,
        name: typeof hello?.name === 'string' && hello.name ? hello.name : 'Browser',
        extensionVersion: typeof hello?.extensionVersion === 'string' ? hello.extensionVersion : '',
        listTabs: async () => (await request('tabs.list', {})).tabs,
        disconnect: reason => socket.close(1000, reason),

        async openSession({ clientName }) {
          const ticket = randomUUID();
          const waiting = waitForSessionSocket(ticket);
          const opened = request('session.open', { ticket, clientName });

          // Whichever fails first tells why; the other must not be left unhandled.
          waiting.catch(() => {});
          opened.catch(() => {});

          const session = wrapSession(await Promise.race([waiting, opened.then(() => waiting)]));

          session.setId((await opened).sessionId);
          await session.initialized;

          return session;
        },

        async claimTab(session, tabId) {
          await request('session.claim', { sessionId: session.id, tabId });
        },
      };

      connected.set(identity.id, { browser, socket });
      socket.send(JSON.stringify({ method: 'welcome' }));
      hub.onConnected?.(browser);
    };

    touch();

    socket.on('message', data => {
      const frame = parseFrame(data);

      if (!frame) {
        socket.close(1003, 'Not a JSON frame');

        return;
      }

      touch();

      if (!browser) {
        if (frame.method === 'hello') {
          void admit(frame.params as Partial<HelloParams> | undefined);
        }

        return;
      }

      if (requester.settle(frame)) {
        return;
      }

      if (frame.method === 'ping') {
        socket.send(JSON.stringify({ method: 'pong' }));
      }
    });

    socket.on('close', (_code, reason) => {
      const text = reason.toString() || 'The control link closed';

      clearTimeout(helloTimer);

      if (idle) {
        clearTimeout(idle);
      }

      requester.failAll(text);

      if (browser && connected.get(browser.identity.id)?.socket === socket) {
        connected.delete(browser.identity.id);
        hub.onDisconnected?.(browser, text);
      }
    });

    socket.on('error', error => console.warn('[browser-link] control link error:', error.message));
  };

  return hub;
}
