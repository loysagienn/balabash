// The extension's end of the browser link (src/browser-link/protocol.ts):
// it dials the server by itself and stays connected.
//
// Where the server is was decided when the extension was built
// (build/browser-extension.js): the address is a constant of this bundle.
// Who this browser is the server decides: a pairing — the console page
// hands a one-time code over (background.ts), the `hello` carries it, the
// `welcome` brings the secret — and from then on the `hello` carries the
// secret. The secret, the id and the name of the record and the pause live
// in chrome.storage.local and are written by this module alone.
//
// One control link per browser, held open while the browser is paired and
// not paused. A lost link is dialed again — soon while the service worker
// lives, and by the alarm (background.ts) once Chrome has stopped it.
// Frames in either direction within 30 s keep the worker alive, hence the
// ping. A server that revoked the secret is not dialed again; a server that
// asks for a newer extension is dialed by the alarm only.
//
// A session is opened on the server's request: the session link with the
// request's ticket, a blank tab of its own in the session's tab group. From
// there the session is Playwright's (playwright/clientSession.ts): it owns
// tabs, attaches the debugger and refuses what its policy refuses.
//
// Chrome shows a bar in every window while the debugger is attached; the
// user closing it (the cross or Cancel) detaches the debugger from every
// tab at once. That is the user saying stop: the session ends, instead of
// living on to open new tabs and bring the bar back. A session the user
// stopped — by the bar or by the pause — closes its link with the code that
// says so (CLOSE_SESSION_STOPPED): the agent is told not to come back by
// itself.

import { report, setReportSink } from './diagnostics.ts';
import { windowForTabs } from './windows.ts';
import { Channel } from './playwright/channel';
import { ClientSession } from './playwright/clientSession';
import { isDebuggableUrl } from './playwright/ownedTab';
import type { ChromeListeners } from './playwright/chromeListeners';
import type { TabGroupManager } from './playwright/tabGroupManager';
import type { TabRegistry } from './playwright/tabRegistry';
import {
  CLOSE_SESSION_STOPPED,
  CLOSE_UNAUTHORIZED,
  CLOSE_UNSUPPORTED_PROTOCOL,
  CONTROL_PATH,
  PROTOCOL_VERSION,
  SESSION_PATH,
  compareVersions,
} from '../browser-link/protocol.ts';
import type {
  BrowserTab,
  ControlEvents,
  ControlRequests,
  ExtensionState,
  Frame,
  HelloParams,
  PagePairResult,
  PairError,
  WelcomeParams,
} from '../browser-link/protocol.ts';

const PING_INTERVAL_MS = 20_000;
const OPEN_TIMEOUT_MS = 10_000;
const RETRY_DELAYS_MS = [1000, 2000, 5000, 10_000];
const TAB_GROUP_TITLE = 'Balabash';
// The reason Chrome gives when the user closes its debugging bar.
const DETACHED_BY_USER = 'canceled_by_user';
const STOPPED_BY_USER = 'The user stopped the session in the browser';

// What the extension keeps between the starts of its worker.
type Stored = {
  // Empty while the browser is not paired.
  secret: string;
  browserId: string;
  name: string;
  paused: boolean;
};

// The link as the extension's own pages show it.
export type LinkStatus = {
  state: ExtensionState;
  browserId: string | null;
  name: string;
  // Why the last attempt failed, when it did.
  detail: string;
  // The server builds a newer extension than this one.
  outdated: boolean;
  sessions: { id: number; label: string; tabIds: number[] }[];
};

async function readStored(): Promise<Stored> {
  const stored = await chrome.storage.local.get(['secret', 'browserId', 'name', 'paused']);

  return {
    secret: typeof stored.secret === 'string' ? stored.secret : '',
    browserId: typeof stored.browserId === 'string' ? stored.browserId : '',
    name: typeof stored.name === 'string' ? stored.name : '',
    paused: stored.paused === true,
  };
}

export class Link {
  private _registry: TabRegistry;
  private _groups: TabGroupManager;
  private _listeners: ChromeListeners;
  private _ready: Promise<unknown>;
  private _socket: WebSocket | undefined;
  private _connecting: Promise<void> | undefined;
  private _welcomed = false;
  private _detail = '';
  private _attempt = 0;
  private _retryTimer: ReturnType<typeof setTimeout> | undefined;
  private _pingTimer: ReturnType<typeof setInterval> | undefined;
  private _sessions = new Map<number, { session: ClientSession; label: string }>();
  private _lastSessionId = 0;
  // The pairing the next `hello` carries, until the server answered it.
  private _pairing: { code: string; settle(result: PagePairResult): void } | undefined;
  // The server refused this extension's wire version: only the alarm dials.
  private _unsupported = false;
  private _serverExtensionVersion = '';

  constructor(registry: TabRegistry, groups: TabGroupManager, listeners: ChromeListeners) {
    this._registry = registry;
    this._groups = groups;
    this._listeners = listeners;
    this._ready = Promise.all([registry.ready, groups.ready]);
    // Added after the registry's own listener, so the session still hears of
    // the detach before its link closes.
    listeners.add(chrome.debugger.onDetach, (source, reason) => {
      if (reason === DETACHED_BY_USER && source.tabId !== undefined) {
        this._registry.ownerOf(source.tabId)?.close(STOPPED_BY_USER, CLOSE_SESSION_STOPPED);
      }
    });
  }

  // Idempotent: called at every start of the worker and by the alarm.
  async ensureConnected(): Promise<void> {
    this._connecting ??= this._connect().finally(() => {
      this._connecting = undefined;
    });
    await this._connecting;
  }

  // Pairs this browser with the record the code stands for. The user asked
  // for it on the console page, so a pause ends with it. A link that is up
  // is dropped (its sessions with it): the new `hello` replaces it.
  async pair(code: string): Promise<PagePairResult> {
    this._pairing?.settle({ ok: false, error: 'unreachable' });

    const result = new Promise<PagePairResult>(resolve => {
      const pairing = {
        code,
        settle: (outcome: PagePairResult) => {
          if (this._pairing === pairing) {
            this._pairing = undefined;
          }

          resolve(outcome);
        },
      };

      this._pairing = pairing;
    });

    this._closeEverything('Pairing');
    this._attempt = 0;
    this._unsupported = false;
    // An attempt in flight ends with the socket just closed; the next one
    // carries the code.
    await this._connecting;
    await this.ensureConnected();

    return await result;
  }

  // On pause the extension holds no link: the server cannot reach the browser.
  async setPaused(paused: boolean): Promise<void> {
    await chrome.storage.local.set({ paused });

    if (paused) {
      this._closeEverything('The user paused the extension', CLOSE_SESSION_STOPPED);

      return;
    }

    this._attempt = 0;
    await this.ensureConnected();
  }

  async status(): Promise<LinkStatus> {
    const stored = await readStored();
    const state: ExtensionState = this._pairing
      ? 'connecting'
      : !stored.secret
        ? 'unpaired'
        : stored.paused
          ? 'paused'
          : this._welcomed
            ? 'connected'
            : this._connecting
              ? 'connecting'
              : 'offline';

    return {
      state,
      browserId: stored.secret && stored.browserId ? stored.browserId : null,
      name: stored.secret ? stored.name : '',
      detail: state === 'offline' || state === 'connecting' ? this._detail : '',
      outdated:
        this._unsupported ||
        (this._serverExtensionVersion !== '' && compareVersions(chrome.runtime.getManifest().version, this._serverExtensionVersion) < 0),
      sessions: [...this._sessions].map(([id, { session, label }]) => ({ id, label, tabIds: this._registry.tabIdsOf(session) })),
    };
  }

  private async _connect(): Promise<void> {
    await this._ready;

    const stored = await readStored();
    const pairing = this._pairing;

    if (!pairing && (!stored.secret || stored.paused)) {
      this._closeEverything(stored.paused ? 'Paused' : 'Not paired');

      return;
    }

    if (this._socket && this._socket.readyState <= WebSocket.OPEN) {
      return;
    }

    clearTimeout(this._retryTimer);

    const socket = new WebSocket(`${__SERVER_URL__}${CONTROL_PATH}`);
    const version = { protocol: PROTOCOL_VERSION, extensionVersion: chrome.runtime.getManifest().version };
    const hello: HelloParams = pairing
      ? { ...version, pairingCode: pairing.code, ...(stored.secret ? { previousSecret: stored.secret } : {}) }
      : { ...version, secret: stored.secret };

    this._socket = socket;
    this._welcomed = false;

    await new Promise<void>(resolve => {
      const timer = setTimeout(() => socket.close(), OPEN_TIMEOUT_MS);

      socket.onopen = () => socket.send(JSON.stringify({ method: 'hello', params: hello }));
      socket.onmessage = event => {
        const frame = parseFrame(event.data);

        if (frame?.method === 'welcome' && !this._welcomed) {
          clearTimeout(timer);
          this._welcomed = true;
          void this._onWelcome(socket, (frame.params ?? {}) as Partial<WelcomeParams>, pairing)
            .catch(error => report(`The welcome was not taken: ${error?.message ?? error}`))
            .then(resolve);

          return;
        }

        if (frame && this._welcomed) {
          void this._onFrame(socket, frame);
        }
      };
      socket.onclose = event => {
        clearTimeout(timer);
        void this._onClosed(socket, event, pairing).then(resolve);
      };
    });
  }

  private async _onWelcome(socket: WebSocket, welcome: Partial<WelcomeParams>, pairing: Link['_pairing']): Promise<void> {
    const browserId = typeof welcome.browserId === 'string' ? welcome.browserId : '';
    const name = typeof welcome.name === 'string' ? welcome.name : '';

    if (pairing) {
      if (typeof welcome.secret !== 'string' || !welcome.secret || !browserId) {
        socket.close(1002, 'A welcome without a secret');

        return;
      }

      await chrome.storage.local.set({ secret: welcome.secret, browserId, name, paused: false });
      pairing.settle({ ok: true, browserId });
    } else {
      await chrome.storage.local.set({ browserId, name });
    }

    this._serverExtensionVersion = typeof welcome.currentExtensionVersion === 'string' ? welcome.currentExtensionVersion : '';
    this._unsupported = false;
    this._detail = '';
    this._attempt = 0;
    this._startPing(socket);
    setReportSink(text => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ method: 'report', params: { text } }));
      }
    });
  }

  private async _onClosed(socket: WebSocket, event: CloseEvent, pairing: Link['_pairing']): Promise<void> {
    if (this._socket !== socket) {
      return;
    }

    const reason = event.reason || (this._welcomed ? 'The server closed the link' : 'The server is not reachable');

    this._socket = undefined;
    this._welcomed = false;
    this._detail = reason;
    setReportSink(undefined);
    clearInterval(this._pingTimer);
    // The sessions were the server's: without it they have no client.
    this._closeSessions(reason);

    if (pairing && this._pairing === pairing) {
      // The refusal was of the code: the secret this browser had, if any,
      // stays what it was, and the link goes back to it.
      pairing.settle({ ok: false, error: PAIR_ERRORS[event.code] ?? 'unreachable' });
    } else if (event.code === CLOSE_UNAUTHORIZED) {
      // Revoked: the browser is nobody to this server until paired again.
      await chrome.storage.local.remove(['secret', 'browserId', 'name']);

      return;
    } else if (event.code === CLOSE_UNSUPPORTED_PROTOCOL) {
      this._unsupported = true;
      this._detail = 'The server asks for a newer version of the extension';

      return;
    }

    const delay = RETRY_DELAYS_MS[Math.min(this._attempt++, RETRY_DELAYS_MS.length - 1)];

    clearTimeout(this._retryTimer);
    this._retryTimer = setTimeout(() => void this.ensureConnected(), delay);
  }

  private _startPing(socket: WebSocket): void {
    clearInterval(this._pingTimer);
    this._pingTimer = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ method: 'ping' }));
      }
    }, PING_INTERVAL_MS);
  }

  private async _onFrame(socket: WebSocket, frame: Frame): Promise<void> {
    if (typeof frame.method !== 'string') {
      return;
    }

    if (frame.id === undefined) {
      if (frame.method === 'browser.updated') {
        const { name } = (frame.params ?? {}) as Partial<ControlEvents['browser.updated']>;

        if (typeof name === 'string') {
          await chrome.storage.local.set({ name });
        }
      }

      return;
    }

    const answer = (body: Frame) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ id: frame.id, ...body }));
      }
    };

    try {
      answer({ result: await this._handleRequest(frame.method, frame.params ?? {}) });
    } catch (error: any) {
      answer({ error: error.message, ...(typeof error.code === 'string' ? { code: error.code } : {}) });
    }
  }

  private async _handleRequest(method: string, params: any): Promise<unknown> {
    switch (method) {
      case 'tabs.list':
        return { tabs: await this._listTabs() } satisfies ControlRequests['tabs.list']['result'];
      case 'session.open':
        return await this._openSession(params as ControlRequests['session.open']['params']);
    }

    throw new Error(`Unknown method: ${method}`);
  }

  private async _listTabs(): Promise<BrowserTab[]> {
    const tabs = await chrome.tabs.query({});

    return tabs
      .filter(tab => tab.id !== undefined)
      .map(tab => ({
        id: tab.id!,
        windowId: tab.windowId,
        groupId: tab.groupId,
        title: tab.title ?? '',
        url: tab.url ?? tab.pendingUrl ?? '',
        active: tab.active,
        owned: !this._registry.isFree(tab.id!),
        debuggable: isDebuggableUrl(tab.url ?? tab.pendingUrl),
      }));
  }

  private async _openSession({ ticket, clientName, label }: ControlRequests['session.open']['params']): Promise<ControlRequests['session.open']['result']> {
    const channel = await Channel.open(`${__SERVER_URL__}${SESSION_PATH}?ticket=${encodeURIComponent(ticket)}`);
    const session = new ClientSession(channel, this._registry, { clientName, tabGroup: { title: TAB_GROUP_TITLE }, background: true });
    const sessionId = ++this._lastSessionId;

    this._sessions.set(sessionId, { session, label: typeof label === 'string' ? label : clientName });
    this._didChangeSessions();
    session.onClose = () => {
      this._sessions.delete(sessionId);
      this._didChangeSessions();
      void this._registry.releaseAll(session);
      void this._groups.orphan(session);
    };

    try {
      this._groups.register(session);

      // A session starts with a tab of its own, in the background of a window
      // with tabs — the window the user looks at can be a site installed as
      // an app, which has none.
      const tab = await chrome.tabs.create({ url: 'about:blank', active: false, windowId: await windowForTabs([]) });

      this._registry.claim(tab, session);
      session.didInitialize();
    } catch (error: any) {
      session.close(error.message);

      throw error;
    }

    return { sessionId };
  }

  private _didChangeSessions(): void {
    // Chrome starts a stopped worker for every event that has a listener, so
    // the tab and debugger listeners are on only while a session needs them.
    this._listeners.setEnabled(this._sessions.size > 0);
  }

  private _closeSessions(reason: string, code?: number): void {
    for (const { session } of [...this._sessions.values()]) {
      session.close(reason, code);
    }
  }

  // `sessionCode` — the close code of the sessions' links, when the user is
  // the one who ends them.
  private _closeEverything(reason: string, sessionCode?: number): void {
    clearTimeout(this._retryTimer);
    clearInterval(this._pingTimer);
    this._closeSessions(reason, sessionCode);

    const socket = this._socket;

    this._socket = undefined;
    this._welcomed = false;
    setReportSink(undefined);
    socket?.close(1000, reason);
  }
}

const PAIR_ERRORS: Record<number, PairError> = {
  [CLOSE_UNAUTHORIZED]: 'code_rejected',
  [CLOSE_UNSUPPORTED_PROTOCOL]: 'unsupported_protocol',
};

function parseFrame(data: unknown): Frame | null {
  try {
    const frame: unknown = JSON.parse(String(data));

    return frame && typeof frame === 'object' ? (frame as Frame) : null;
  } catch {
    return null;
  }
}
