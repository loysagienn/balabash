// The server's end of the browser links: accepts the links the extensions
// open (protocol.ts), keeps the browsers that are connected now, asks them
// what the server needs and opens sessions in them.
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
// The extension pings every 20 s; a control link silent for a minute is
// dead.
//
// A session link is admitted by its ticket: random, good for one use and a
// few seconds, handed to the extension over the control link that has
// already said who it is. A session lives inside its control link — the
// extension ends its sessions when it loses the server, and so does the hub
// when it loses the browser. How a session ended (SessionEnd) is told by
// the side that ended it, with the close code of the wire. What concerns a
// session but is not Playwright's — asking the user for a tab, hearing that
// the extension took a tab away — travels over the control link and names
// the session by the id the extension gave it.
//
// A session whose agent is idle is parked (ParkedSession): the extension is
// asked to let its tabs go and keep their group, and the session link is
// closed — with the last debugger Chrome's bar leaves the user's windows.
// The parked session is still a session of its control link: it ends with
// the link, by the user's stop (a notice of the extension) or by the
// server's own hand, and it comes back by opening a session that names it.
// An extension older than PARKING_SINCE_VERSION does not park.
//
// The frames of a session link are handled one per turn of the event loop,
// in the order they came. An answer reaches whoever waits for it through a
// chain of promises, an event at once — and two frames that came in one
// read of the socket would otherwise swap: the event would overtake the
// answer sent before it. A CDP client counts on that order (Playwright
// starts to listen for the execution contexts of a page only when the
// answer with its frame tree has come), and a page that was loaded before
// the session took it has its contexts announced right behind that answer.
//
// Both kinds of link carry the server's WebSocket pings every 25 s: a
// session whose agent waits for its operator says nothing, and the proxies
// on the way close a silent connection. A ping left unanswered until the
// next one means the other side is gone.

import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import {
  CLOSE_SESSION_REVOKED,
  CLOSE_SESSION_STOPPED,
  CLOSE_UNAUTHORIZED,
  CLOSE_UNSUPPORTED_PROTOCOL,
  CONTROL_PATH,
  PARKING_SINCE_VERSION,
  PROTOCOL_VERSION,
  SESSION_OVER,
  SESSION_PATH,
  compareVersions,
} from './protocol.ts';
import type {
  BrowserTab,
  ControlEvents,
  ControlMethod,
  ControlRequests,
  Frame,
  HelloParams,
  SessionNotice,
  WelcomeParams,
} from './protocol.ts';

const HELLO_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 30_000;
// Asking for a tab waits for the user, who has a minute to answer.
const CLAIM_TIMEOUT_MS = 90_000;
// Silence for this long means the link is dead: the extension pings every 20 s.
const IDLE_TIMEOUT_MS = 60_000;
const PING_INTERVAL_MS = 25_000;
// How long the extension has to dial the session link its ticket is for.
const TICKET_TTL_MS = 15_000;
// A frame of the control link is small: a list of tabs at most.
const MAX_CONTROL_FRAME_BYTES = 4 * 1024 * 1024;
// A frame of a session link carries what CDP carries: a screenshot, a page.
const MAX_SESSION_FRAME_BYTES = 256 * 1024 * 1024;

// Whom `admit` recognized behind a `hello`. `secret` — the pairing has just
// made it, and the `welcome` carries it to the extension, once.
export type Admission = { browserId: string; name: string; secret?: string };

// How a session ended: the server closed it (the agent is done); the user
// stopped it in the browser; the browser's access was withdrawn; the link to
// the browser was lost.
export type SessionEnd = 'closed' | 'stopped' | 'revoked' | 'lost';

// The session link of one agent run, in the vocabulary of the extension
// (the commands and events of the Playwright extension).
export type ExtensionSession = {
  // The id the extension knows the session by.
  id: number;
  send(method: string, params: unknown[]): Promise<unknown>;
  // Events that came before a listener was set wait for it.
  onEvent: ((method: string, params: unknown[]) => void) | null;
  // Asks the user for one of their tabs; resolves once they agreed. A
  // refusal is a BrowserRequestError with the code of the wire.
  claimTab(tabId: number): Promise<void>;
  // What the extension did to the session by the user's rules.
  onNotice: ((notice: SessionNotice) => void) | null;
  // Settles once, when the link is gone: how, and what was said about it.
  ended: Promise<{ end: SessionEnd; detail: string }>;
  // The server ends the session: done with it by default.
  close(end?: Exclude<SessionEnd, 'stopped'>, detail?: string): void;
  // Whether the extension behind the link parks sessions.
  canPark: boolean;
  // Parks the session: the extension lets its tabs go and keeps their
  // group, and the link closes as closed by the server. A refusal ends the
  // session as lost — what the extension holds of it is not known.
  park(): Promise<ParkedSession>;
};

// A session the extension keeps without a link while its agent is idle.
export type ParkedSession = {
  // The id the extension keeps the session by.
  id: number;
  // Settles once if the session ended before it came back: how, and what
  // was said about it. A session that came back leaves it unsettled.
  ended: Promise<{ end: SessionEnd; detail: string }>;
  // The session comes back: a new link, and the tabs of its group — the
  // ones of `tabIds` first, in that order. A failure ends it as lost.
  resume(options: { clientName: string; label: string; tabIds: number[] }): Promise<ExtensionSession>;
  // The server is done with the session, or withdraws the browser from it.
  close(end?: 'closed' | 'revoked'): void;
};

export type ConnectedBrowser = {
  id: string;
  // What the extension said in its `hello`.
  extensionVersion: string;
  listTabs(): Promise<BrowserTab[]>;
  // `clientName` names the client in the extension's own words, `label` is
  // what the user reads about the session.
  openSession(options: { clientName: string; label: string }): Promise<ExtensionSession>;
};

export type BrowserLinkHub = {
  // True when the request was the hub's — admitted or refused; false leaves
  // it to the owner of the server.
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean;
  browser(browserId: string): ConnectedBrowser | null;
  // Tells the extension the name the user gave the browser in the console.
  renamed(browserId: string, name: string): void;
  // The browser is nobody from now on: its link and its sessions close for good.
  revoke(browserId: string): void;
  // A browser connected or its link is gone.
  onPresence: ((browserId: string, connected: boolean) => void) | null;
  // A trouble the extension reported about itself.
  onReport: ((browserId: string, text: string) => void) | null;
  close(): void;
};

type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout | null };

// The refusal of a request, with the machine form the extension gave it.
export class BrowserRequestError extends Error {
  code: string | null;

  constructor(message: string, code: string | null = null) {
    super(message);
    this.code = code;
  }
}

// Requests one way, events the other, over one socket. `timeoutMs` null —
// a request waits for its answer as long as the link lives.
function createRequester(socket: WebSocket, defaultTimeoutMs: number | null) {
  const pending = new Map<number, Pending>();
  let lastId = 0;

  return {
    request(method: string, params: unknown, timeoutMs: number | null = defaultTimeoutMs): Promise<unknown> {
      if (socket.readyState !== socket.OPEN) {
        return Promise.reject(new BrowserRequestError('The browser link is closed'));
      }

      const id = ++lastId;

      socket.send(JSON.stringify({ id, method, params }));

      return new Promise((resolve, reject) => {
        const timer =
          timeoutMs === null
            ? null
            : setTimeout(() => {
                pending.delete(id);
                reject(new BrowserRequestError(`The browser did not answer ${method} in ${timeoutMs / 1000} s`));
              }, timeoutMs);

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

      if (waiting.timer) {
        clearTimeout(waiting.timer);
      }

      if (frame.error !== undefined) {
        waiting.reject(new BrowserRequestError(String(frame.error), typeof frame.code === 'string' ? frame.code : null));
      } else {
        waiting.resolve(frame.result);
      }

      return true;
    },

    failAll(reason: string) {
      for (const waiting of pending.values()) {
        if (waiting.timer) {
          clearTimeout(waiting.timer);
        }

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

// The server's pings on a link; answers what stops them. A ping the other
// side left unanswered until the next one ends the link.
function keepAlive(socket: WebSocket, intervalMs: number): () => void {
  let answered = true;
  const timer = setInterval(() => {
    if (!answered) {
      socket.terminate();

      return;
    }

    answered = false;

    if (socket.readyState === socket.OPEN) {
      socket.ping();
    }
  }, intervalMs);

  socket.on('pong', () => {
    answered = true;
  });

  return () => clearInterval(timer);
}

// What the extension's close of a session link says.
function endOfSession(code: number): SessionEnd {
  return code === CLOSE_SESSION_STOPPED ? 'stopped' : 'lost';
}

const SERVER_CLOSE: Record<Exclude<SessionEnd, 'stopped'>, { code: number; detail: string }> = {
  closed: { code: 1000, detail: 'The session is over' },
  revoked: { code: CLOSE_SESSION_REVOKED, detail: 'Access to the browser was withdrawn' },
  lost: { code: 1001, detail: 'The link to the browser is gone' },
};

type OpenSession = ExtensionSession & { initialized: Promise<void>; setId(id: number): void };

// What a session asks of its control link: a tab of the user, and to be parked.
type SessionControl = {
  claimTab(sessionId: number, tabId: number): Promise<void>;
  canPark(): boolean;
  park(session: OpenSession): Promise<ParkedSession>;
};

type Outcome = { end: SessionEnd; detail: string };

const STOPPED_BY_USER = 'The user stopped the session in the browser';

export function createBrowserLinkHub(options: {
  admit(hello: HelloParams): Promise<Admission | null>;
  // The version of the extension this installation builds; '' when it builds none.
  extensionVersion(): Promise<string>;
  // What the upgrade request must name: the console host (the `Host`
  // header) and the origin of the extension. Null — any: a stand that is
  // reached by an address of its own.
  host: string | null;
  origin: string | null;
  // How long a link may stay silent, how long it may take to say `hello`,
  // and how often the server pings.
  idleTimeoutMs?: number;
  helloTimeoutMs?: number;
  pingIntervalMs?: number;
}): BrowserLinkHub {
  const idleTimeoutMs = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
  const helloTimeoutMs = options.helloTimeoutMs ?? HELLO_TIMEOUT_MS;
  const pingIntervalMs = options.pingIntervalMs ?? PING_INTERVAL_MS;
  const controlSockets = new WebSocketServer({ noServer: true, maxPayload: MAX_CONTROL_FRAME_BYTES });
  const sessionSockets = new WebSocketServer({ noServer: true, maxPayload: MAX_SESSION_FRAME_BYTES });
  // `parked` — how each parked session of the link is ended, by its id.
  const connected = new Map<
    string,
    { browser: ConnectedBrowser; socket: WebSocket; sessions: Set<OpenSession>; parked: Map<number, (outcome: Outcome) => void> }
  >();
  const tickets = new Map<string, { take(socket: WebSocket): void; timer: NodeJS.Timeout }>();

  const send = <E extends keyof ControlEvents>(socket: WebSocket, method: E | 'welcome', params?: ControlEvents[E] | WelcomeParams) => {
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(params === undefined ? { method } : { method, params }));
    }
  };

  // The session link the extension dials with the ticket; rejects when it
  // does not come in time.
  const sessionSocket = (ticket: string): { socket: Promise<WebSocket>; forget(): void } => {
    let forget = () => {};
    const socket = new Promise<WebSocket>((resolve, reject) => {
      const timer = setTimeout(() => {
        tickets.delete(ticket);
        reject(new BrowserRequestError('The browser did not open the session link'));
      }, TICKET_TTL_MS);

      tickets.set(ticket, { take: resolve, timer });
      forget = () => {
        clearTimeout(timer);
        tickets.delete(ticket);
      };
    });

    return { socket, forget };
  };

  const wrapSession = (socket: WebSocket, control: SessionControl): OpenSession => {
    const requester = createRequester(socket, null);
    const stopPings = keepAlive(socket, pingIntervalMs);
    let markInitialized!: () => void;
    let failInitialized!: (error: Error) => void;
    const initialized = new Promise<void>((resolve, reject) => {
      markInitialized = resolve;
      failInitialized = reject;
    });
    let markEnded!: (value: { end: SessionEnd; detail: string }) => void;
    const ended = new Promise<{ end: SessionEnd; detail: string }>(resolve => {
      markEnded = resolve;
    });
    // The first tab is announced ahead of `extension.initialized`.
    const early: [string, unknown[]][] = [];
    let onEvent: ExtensionSession['onEvent'] = null;
    let id = 0;
    // Set when the server is the one that ends the session.
    let ending: { end: SessionEnd; detail: string } | null = null;

    const session: OpenSession = {
      get id() {
        return id;
      },
      setId(value) {
        id = value;
      },
      initialized,
      ended,
      onNotice: null,
      claimTab: tabId => control.claimTab(id, tabId),
      get canPark() {
        return control.canPark();
      },
      park: () => control.park(session),
      send: (method, params) => requester.request(method, params),
      get onEvent() {
        return onEvent;
      },
      set onEvent(listener) {
        onEvent = listener;

        if (listener) {
          for (const [method, params] of early.splice(0)) {
            listener(method, params);
          }
        }
      },
      close(end = 'closed', detail) {
        if (ending || socket.readyState > socket.OPEN) {
          return;
        }

        ending = { end, detail: detail ?? SERVER_CLOSE[end].detail };
        socket.close(SERVER_CLOSE[end].code, ending.detail.slice(0, 100));
      },
    };

    const handle = (frame: Frame) => {
      if (requester.settle(frame) || typeof frame.method !== 'string') {
        return;
      }

      if (frame.method === 'extension.initialized') {
        markInitialized();

        return;
      }

      const params = Array.isArray(frame.params) ? frame.params : [];

      if (onEvent) {
        onEvent(frame.method, params);
      } else {
        early.push([frame.method, params]);
      }
    };
    // One frame per turn of the event loop (see the header).
    let turn: Promise<void> = Promise.resolve();

    socket.on('message', data => {
      const frame = parseFrame(data);

      if (!frame) {
        socket.close(1003, 'Not a JSON frame');

        return;
      }

      turn = turn.then(() => {
        try {
          handle(frame);
        } catch (error) {
          console.error('[browser-link] a frame of a session was not handled:', error);
        }

        return new Promise<void>(resolve => setImmediate(resolve));
      });
    });

    socket.on('close', (code, reason) => {
      const said = reason.toString();
      const outcome = ending ?? { end: endOfSession(code), detail: said || 'The session link closed' };

      stopPings();
      requester.failAll(outcome.detail);
      failInitialized(new BrowserRequestError(outcome.detail));
      markEnded(outcome);
    });

    socket.on('error', error => console.warn('[browser-link] session link error:', error.message));
    initialized.catch(() => {});

    return session;
  };

  const acceptControl = (socket: WebSocket) => {
    const requester = createRequester(socket, REQUEST_TIMEOUT_MS);
    const stopPings = keepAlive(socket, pingIntervalMs);
    const sessions = new Set<OpenSession>();
    const parked = new Map<number, (outcome: Outcome) => void>();
    let canPark = false;
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

    const request = <M extends ControlMethod>(method: M, params: ControlRequests[M]['params'], timeoutMs?: number) =>
      requester.request(method, params, timeoutMs) as Promise<ControlRequests[M]['result']>;

    const open = async ({
      clientName,
      label,
      resume,
    }: {
      clientName: string;
      label: string;
      resume?: ControlRequests['session.open']['params']['resume'];
    }): Promise<OpenSession> => {
      const ticket = randomBytes(32).toString('base64url');
      const dialed = sessionSocket(ticket);
      const opened = request('session.open', { ticket, clientName, label, ...(resume ? { resume } : {}) });

      // Whichever fails first tells why; the other must not be left unhandled.
      dialed.socket.catch(() => {});
      opened.catch(() => {});

      let session: OpenSession;

      try {
        session = wrapSession(await Promise.race([dialed.socket, opened.then(() => dialed.socket)]), control);
      } catch (error) {
        dialed.forget();

        throw error;
      }

      try {
        session.setId((await opened).sessionId);
        await session.initialized;
      } catch (error) {
        session.close('lost');

        throw error;
      }

      if (socket.readyState !== socket.OPEN) {
        session.close('lost');

        throw new BrowserRequestError('The browser link is closed');
      }

      sessions.add(session);
      void session.ended.then(() => sessions.delete(session));

      return session;
    };

    const park = async (session: OpenSession): Promise<ParkedSession> => {
      const id = session.id;

      try {
        await request('session.park', { sessionId: id });
      } catch (error) {
        session.close('lost');

        throw error;
      }

      let over = false;
      let settle!: (outcome: Outcome) => void;
      const ended = new Promise<Outcome>(resolve => {
        settle = resolve;
      });
      // True for the one call that takes the session out of the parked ones.
      const leave = () => {
        if (over) {
          return false;
        }

        over = true;
        parked.delete(id);

        return true;
      };

      parked.set(id, outcome => {
        if (leave()) {
          settle(outcome);
        }
      });
      session.close('closed', 'The session is parked');

      return {
        id,
        ended,
        resume: async ({ clientName, label, tabIds }) => {
          if (!leave()) {
            throw new BrowserRequestError('This session is over');
          }

          try {
            return await open({ clientName, label, resume: { sessionId: id, tabIds } });
          } catch (error) {
            // The extension holds the session no more — the user has stopped
            // it, and the word of it is still on its way — or what it holds
            // of the session is not known, and it lets go.
            const stopped = error instanceof BrowserRequestError && error.code === SESSION_OVER;

            send(socket, 'session.drop', { sessionId: id });
            settle(stopped ? { end: 'stopped', detail: STOPPED_BY_USER } : { end: 'lost', detail: error instanceof Error ? error.message : String(error) });

            throw error;
          }
        },
        close: (end = 'closed') => {
          if (leave()) {
            send(socket, 'session.drop', { sessionId: id });
            settle({ end, detail: SERVER_CLOSE[end].detail });
          }
        },
      };
    };

    const control: SessionControl = {
      claimTab: async (sessionId, tabId) => {
        await request('session.claim', { sessionId, tabId }, CLAIM_TIMEOUT_MS);
      },
      canPark: () => canPark,
      park,
    };
    const openSession: ConnectedBrowser['openSession'] = ({ clientName, label }) => open({ clientName, label });

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

      canPark = compareVersions(hello!.extensionVersion, PARKING_SINCE_VERSION) >= 0;
      browser = {
        id: admission.browserId,
        extensionVersion: hello!.extensionVersion,
        listTabs: async () => (await request('tabs.list', {})).tabs,
        openSession,
      };
      connected.set(browser.id, { browser, socket, sessions, parked });
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
      } else if (frame.method === 'session.notice') {
        const notice = (frame.params ?? {}) as { sessionId?: unknown; kind?: unknown; tabId?: unknown };

        if (notice.kind === 'tab_blocked' && typeof notice.tabId === 'number') {
          for (const session of sessions) {
            if (session.id === notice.sessionId) {
              session.onNotice?.({ sessionId: session.id, kind: notice.kind, tabId: notice.tabId });
            }
          }
        } else if (notice.kind === 'stopped' && typeof notice.sessionId === 'number') {
          parked.get(notice.sessionId)?.({ end: 'stopped', detail: STOPPED_BY_USER });
        }
      }
    });

    socket.on('close', (_code, reason) => {
      clearTimeout(helloTimer);
      stopPings();

      if (idle) {
        clearTimeout(idle);
      }

      requester.failAll(reason.toString() || 'The browser link closed');

      // A session has no browser to speak to without its control link. One
      // the revocation already closed keeps its own reason.
      for (const session of sessions) {
        session.close('lost');
      }

      for (const end of [...parked.values()]) {
        end({ end: 'lost', detail: SERVER_CLOSE.lost.detail });
      }

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

      if (url.pathname !== CONTROL_PATH && url.pathname !== SESSION_PATH) {
        return false;
      }

      const host = String(request.headers.host ?? '').toLowerCase();

      if ((options.host !== null && host !== options.host) || (options.origin !== null && request.headers.origin !== options.origin)) {
        refuse(socket, '403 Forbidden');

        return true;
      }

      if (url.pathname === CONTROL_PATH) {
        controlSockets.handleUpgrade(request, socket, head, acceptControl);

        return true;
      }

      const ticket = url.searchParams.get('ticket') ?? '';
      const waiting = tickets.get(ticket);

      if (!waiting) {
        refuse(socket, '403 Forbidden');

        return true;
      }

      // One use.
      tickets.delete(ticket);
      clearTimeout(waiting.timer);
      sessionSockets.handleUpgrade(request, socket, head, waiting.take);

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

        for (const session of entry.sessions) {
          session.close('revoked');
        }

        for (const end of [...entry.parked.values()]) {
          end({ end: 'revoked', detail: SERVER_CLOSE.revoked.detail });
        }

        entry.socket.close(CLOSE_UNAUTHORIZED, 'Disconnected in the console');
        hub.onPresence?.(browserId, false);
      }
    },

    close() {
      for (const { socket } of connected.values()) {
        socket.close(1001, 'Server is closing');
      }

      controlSockets.close();
      sessionSockets.close();
    },
  };

  return hub;
}
