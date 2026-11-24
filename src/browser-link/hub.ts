// The server's end of the browser links: accepts the control links the
// extensions open (protocol.ts), keeps the browsers that are connected now
// and asks them what the server needs.
//
// The hub owns no HTTP server and no storage. The owner of a server hands
// it the upgrade requests; who a `hello` is decides `admit` — a known
// secret, or a pairing that has just made the browser — and the hub only
// carries the frame to it. A browser has one control link: a new one of the
// same browser replaces the previous.
//
// A link is refused before it is a WebSocket unless the request names the
// console host and comes from the extension (its origin); a `hello` of
// another wire version or of nobody closes it with the codes of the wire.
// The extension pings every 20 s; a link silent for a minute is dead.

import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import { CLOSE_UNAUTHORIZED, CLOSE_UNSUPPORTED_PROTOCOL, CONTROL_PATH, PROTOCOL_VERSION } from './protocol.ts';
import type { BrowserTab, ControlEvents, ControlMethod, ControlRequests, Frame, HelloParams, WelcomeParams } from './protocol.ts';

const HELLO_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 30_000;
// Silence for this long means the link is dead: the extension pings every 20 s.
const IDLE_TIMEOUT_MS = 60_000;
// A frame of the control link is small: a list of tabs at most.
const MAX_FRAME_BYTES = 4 * 1024 * 1024;

// Whom `admit` recognized behind a `hello`. `secret` — the pairing has just
// made it, and the `welcome` carries it to the extension, once.
export type Admission = { browserId: string; name: string; secret?: string };

export type ConnectedBrowser = {
  id: string;
  // What the extension said in its `hello`.
  extensionVersion: string;
  listTabs(): Promise<BrowserTab[]>;
};

export type BrowserLinkHub = {
  // True when the request was the hub's — admitted or refused; false leaves
  // it to the owner of the server.
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean;
  browser(browserId: string): ConnectedBrowser | null;
  // Tells the extension the name the user gave the browser in the console.
  renamed(browserId: string, name: string): void;
  // The browser is nobody from now on: its link closes for good.
  revoke(browserId: string): void;
  // A browser connected or its link is gone.
  onPresence: ((browserId: string, connected: boolean) => void) | null;
  // A trouble the extension reported about itself.
  onReport: ((browserId: string, text: string) => void) | null;
  close(): void;
};

type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout };

// The refusal of a request, with the machine form the extension gave it.
export class BrowserRequestError extends Error {
  code: string | null;

  constructor(message: string, code: string | null = null) {
    super(message);
    this.code = code;
  }
}

// Requests one way, events the other, over one socket.
function createRequester(socket: WebSocket) {
  const pending = new Map<number, Pending>();
  let lastId = 0;

  return {
    request(method: string, params: unknown): Promise<unknown> {
      if (socket.readyState !== socket.OPEN) {
        return Promise.reject(new BrowserRequestError('The browser link is closed'));
      }

      const id = ++lastId;

      socket.send(JSON.stringify({ id, method, params }));

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new BrowserRequestError(`The browser did not answer ${method} in ${REQUEST_TIMEOUT_MS / 1000} s`));
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
        waiting.reject(new BrowserRequestError(String(frame.error), typeof frame.code === 'string' ? frame.code : null));
      } else {
        waiting.resolve(frame.result);
      }

      return true;
    },

    failAll(reason: string) {
      for (const waiting of pending.values()) {
        clearTimeout(waiting.timer);
        waiting.reject(new BrowserRequestError(reason));
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

// A `hello` that names a version and either a secret or a pairing code.
function parseHello(params: unknown): HelloParams | null {
  const hello = params && typeof params === 'object' ? (params as Record<string, unknown>) : null;

  if (!hello || typeof hello.protocol !== 'number') {
    return null;
  }

  const version = { protocol: hello.protocol, extensionVersion: typeof hello.extensionVersion === 'string' ? hello.extensionVersion.slice(0, 40) : '' };

  if (typeof hello.pairingCode === 'string' && hello.pairingCode) {
    return {
      ...version,
      pairingCode: hello.pairingCode,
      ...(typeof hello.previousSecret === 'string' && hello.previousSecret ? { previousSecret: hello.previousSecret } : {}),
    };
  }

  return typeof hello.secret === 'string' && hello.secret ? { ...version, secret: hello.secret } : null;
}

function refuse(socket: Duplex, status: string): void {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

export function createBrowserLinkHub(options: {
  admit(hello: HelloParams): Promise<Admission | null>;
  // The version of the extension this installation builds; '' when it builds none.
  extensionVersion(): Promise<string>;
  // What the upgrade request must name: the console host (the `Host`
  // header) and the origin of the extension. Null — any: a stand that is
  // reached by an address of its own.
  host: string | null;
  origin: string | null;
  // How long a link may stay silent, and how long it may take to say `hello`.
  idleTimeoutMs?: number;
  helloTimeoutMs?: number;
}): BrowserLinkHub {
  const idleTimeoutMs = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
  const helloTimeoutMs = options.helloTimeoutMs ?? HELLO_TIMEOUT_MS;
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  const connected = new Map<string, { browser: ConnectedBrowser; socket: WebSocket }>();

  const send = <E extends keyof ControlEvents>(socket: WebSocket, method: E | 'welcome', params?: ControlEvents[E] | WelcomeParams) => {
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(params === undefined ? { method } : { method, params }));
    }
  };

  const acceptControl = (socket: WebSocket) => {
    const requester = createRequester(socket);
    let browser: ConnectedBrowser | null = null;
    let admitting = false;
    let idle: NodeJS.Timeout | null = null;
    const helloTimer = setTimeout(() => socket.close(CLOSE_UNAUTHORIZED, 'No hello'), helloTimeoutMs);

    const touch = () => {
      if (idle) {
        clearTimeout(idle);
      }

      idle = setTimeout(() => socket.terminate(), idleTimeoutMs);
    };

    const request = <M extends ControlMethod>(method: M, params: ControlRequests[M]['params']) =>
      requester.request(method, params) as Promise<ControlRequests[M]['result']>;

    const admit = async (params: unknown) => {
      const hello = parseHello(params);

      clearTimeout(helloTimer);

      if (hello && hello.protocol !== PROTOCOL_VERSION) {
        socket.close(CLOSE_UNSUPPORTED_PROTOCOL, 'Unsupported version of the wire');

        return;
      }

      const admission = hello ? await options.admit(hello) : null;

      if (!admission) {
        socket.close(CLOSE_UNAUTHORIZED, 'Not recognized');

        return;
      }

      if (socket.readyState !== socket.OPEN) {
        return;
      }

      // The same browser dialing again replaces its previous link.
      connected.get(admission.browserId)?.socket.close(1000, 'Replaced by a new link');

      browser = {
        id: admission.browserId,
        extensionVersion: hello!.extensionVersion,
        listTabs: async () => (await request('tabs.list', {})).tabs,
      };
      connected.set(browser.id, { browser, socket });
      send(socket, 'welcome', {
        browserId: admission.browserId,
        name: admission.name,
        currentExtensionVersion: await options.extensionVersion(),
        ...(admission.secret ? { secret: admission.secret } : {}),
      });
      hub.onPresence?.(browser.id, true);
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
        if (frame.method === 'hello' && !admitting) {
          admitting = true;
          admit(frame.params).catch(error => {
            console.error('[browser-link] a hello was not admitted:', error);
            socket.close(1011, 'The server failed');
          });
        }

        return;
      }

      if (requester.settle(frame)) {
        return;
      }

      if (frame.method === 'ping') {
        send(socket, 'pong');
      } else if (frame.method === 'report') {
        const text = (frame.params as { text?: unknown } | undefined)?.text;

        hub.onReport?.(browser.id, String(text).slice(0, 2000));
      }
    });

    socket.on('close', (_code, reason) => {
      clearTimeout(helloTimer);

      if (idle) {
        clearTimeout(idle);
      }

      requester.failAll(reason.toString() || 'The browser link closed');

      if (browser && connected.get(browser.id)?.socket === socket) {
        connected.delete(browser.id);
        hub.onPresence?.(browser.id, false);
      }
    });

    socket.on('error', error => console.warn('[browser-link] control link error:', error.message));
  };

  const hub: BrowserLinkHub = {
    onPresence: null,
    onReport: null,
    browser: browserId => connected.get(browserId)?.browser ?? null,

    handleUpgrade(request, socket, head) {
      const url = new URL(request.url ?? '/', 'http://link');

      if (url.pathname !== CONTROL_PATH) {
        return false;
      }

      const host = String(request.headers.host ?? '').toLowerCase();

      if ((options.host !== null && host !== options.host) || (options.origin !== null && request.headers.origin !== options.origin)) {
        refuse(socket, '403 Forbidden');

        return true;
      }

      sockets.handleUpgrade(request, socket, head, acceptControl);

      return true;
    },

    renamed(browserId, name) {
      const entry = connected.get(browserId);

      if (entry) {
        send(entry.socket, 'browser.updated', { name });
      }
    },

    revoke(browserId) {
      const entry = connected.get(browserId);

      if (entry) {
        // Gone at once, not when the close has travelled.
        connected.delete(browserId);
        entry.socket.close(CLOSE_UNAUTHORIZED, 'Disconnected in the console');
        hub.onPresence?.(browserId, false);
      }
    },

    close() {
      for (const { socket } of connected.values()) {
        socket.close(1001, 'Server is closing');
      }

      sockets.close();
    },
  };

  return hub;
}
