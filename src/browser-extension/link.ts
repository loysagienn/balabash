// The extension's end of the browser link (src/browser-link/protocol.ts):
// it dials the server by itself and stays connected.
//
// One control link per browser, held open while the settings name a server
// and the link is not paused: `hello` with the token, then the server's
// requests. A lost link is dialed again — soon while the service worker
// lives, and by the alarm (background.ts) once Chrome has stopped it.
// Frames in either direction within 30 s keep the worker alive, hence the
// ping.
//
// A session is opened on the server's request: the session link with the
// request's ticket, a blank tab of its own in the session's tab group. From
// there the session is Playwright's (playwright/clientSession.ts): it owns
// tabs, attaches the debugger and refuses what its policy refuses.
//
// Chrome shows a bar in every window while the debugger is attached; the
// user closing it (the cross or Cancel) detaches the debugger from every
// tab at once. That is the user saying stop: the session ends, instead of
// living on to open new tabs and bring the bar back.

import { setReportSink } from './diagnostics.ts';
import { windowForTabs } from './windows.ts';
import { Channel } from './playwright/channel';
import { ClientSession } from './playwright/clientSession';
import { isDebuggableUrl } from './playwright/ownedTab';
import type { ChromeListeners } from './playwright/chromeListeners';
import type { TabGroupManager } from './playwright/tabGroupManager';
import type { TabRegistry } from './playwright/tabRegistry';
import { CONTROL_PATH, SESSION_PATH } from '../browser-link/protocol.ts';
import type { BrowserTab, ControlRequests, Frame, HelloParams } from '../browser-link/protocol.ts';

const PING_INTERVAL_MS = 20_000;
const OPEN_TIMEOUT_MS = 10_000;
const RETRY_DELAYS_MS = [1000, 2000, 5000, 10_000];
const TAB_GROUP_TITLE = 'Balabash';
// The reason Chrome gives when the user closes its debugging bar.
const DETACHED_BY_USER = 'canceled_by_user';
const STOPPED_BY_USER = 'The user stopped the session in the browser';

export type Settings = {
  // wss://host of the server, no path.
  serverUrl: string;
  token: string;
  name: string;
  paused: boolean;
};

export type LinkStatus = {
  state: 'unconfigured' | 'paused' | 'connecting' | 'connected' | 'offline';
  // Why the last attempt failed, when it did.
  detail: string;
  sessions: { id: number; clientName: string; tabIds: number[] }[];
};

export async function readSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(['serverUrl', 'token', 'name', 'paused']);

  return {
    serverUrl: typeof stored.serverUrl === 'string' ? stored.serverUrl.trim().replace(/\/+$/, '') : '',
    token: typeof stored.token === 'string' ? stored.token.trim() : '',
    name: typeof stored.name === 'string' ? stored.name.trim() : '',
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
  private _sessions = new Map<number, ClientSession>();
  private _lastSessionId = 0;
  private _settings: Settings | undefined;

  constructor(registry: TabRegistry, groups: TabGroupManager, listeners: ChromeListeners) {
    this._registry = registry;
    this._groups = groups;
    this._listeners = listeners;
    this._ready = Promise.all([registry.ready, groups.ready]);
    // Added after the registry's own listener, so the session still hears of
    // the detach before its link closes.
    listeners.add(chrome.debugger.onDetach, (source, reason) => {
      if (reason === DETACHED_BY_USER && source.tabId !== undefined) {
        this._registry.ownerOf(source.tabId)?.close(STOPPED_BY_USER);
      }
    });
  }

  // Idempotent: called at every start of the worker, by the alarm and after
  // a change of the settings.
  async ensureConnected(): Promise<void> {
    this._connecting ??= this._connect().finally(() => {
      this._connecting = undefined;
    });
    await this._connecting;
  }

  // The settings changed: drop the link (and the sessions with it) and dial
  // again with the new ones.
  async restart(): Promise<void> {
    this._closeEverything('Settings changed');
    this._attempt = 0;
    // An attempt in flight ends with the socket just closed; the next one
    // reads the new settings.
    await this._connecting;
    await this.ensureConnected();
  }

  async status(): Promise<LinkStatus> {
    const settings = this._settings ?? (await readSettings());
    const state = !settings.serverUrl || !settings.token
      ? 'unconfigured'
      : settings.paused
        ? 'paused'
        : this._welcomed
          ? 'connected'
          : this._connecting
            ? 'connecting'
            : 'offline';

    return {
      state,
      detail: state === 'offline' || state === 'connecting' ? this._detail : '',
      sessions: [...this._sessions].map(([id, session]) => ({
        id,
        clientName: session.options.clientName,
        tabIds: this._registry.tabIdsOf(session),
      })),
    };
  }

  private async _connect(): Promise<void> {
    await this._ready;
    this._settings = await readSettings();

    const { serverUrl, token, name, paused } = this._settings;

    if (!serverUrl || !token || paused) {
      this._closeEverything(paused ? 'Paused' : 'Not configured');

      return;
    }

    if (this._socket && this._socket.readyState <= WebSocket.OPEN) {
      return;
    }

    clearTimeout(this._retryTimer);

    let socket: WebSocket;

    try {
      socket = new WebSocket(`${serverUrl}${CONTROL_PATH}`);
    } catch (error: any) {
      this._detail = `Bad server address: ${error.message}`;

      return;
    }

    this._socket = socket;
    this._welcomed = false;

    const hello: HelloParams = { token, name: name || 'Browser', extensionVersion: chrome.runtime.getManifest().version };

    await new Promise<void>(resolve => {
      const timer = setTimeout(() => socket.close(), OPEN_TIMEOUT_MS);

      socket.onopen = () => socket.send(JSON.stringify({ method: 'hello', params: hello }));
      socket.onmessage = event => {
        const frame = parseFrame(event.data);

        if (frame?.method === 'welcome' && !this._welcomed) {
          clearTimeout(timer);
          this._welcomed = true;
          this._detail = '';
          this._attempt = 0;
          this._startPing(socket);
          setReportSink(text => {
            if (socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({ method: 'report', params: { text } }));
            }
          });
          resolve();

          return;
        }

        if (frame && this._welcomed) {
          void this._onFrame(socket, frame);
        }
      };
      socket.onclose = event => {
        clearTimeout(timer);
        this._onClosed(socket, event.reason || (this._welcomed ? 'The server closed the link' : 'The server is not reachable'));
        resolve();
      };
    });
  }

  private _onClosed(socket: WebSocket, reason: string): void {
    if (this._socket !== socket) {
      return;
    }

    this._socket = undefined;
    this._welcomed = false;
    this._detail = reason;
    setReportSink(undefined);
    clearInterval(this._pingTimer);
    // The sessions were the server's: without it they have no client.
    this._closeSessions(reason);

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
    if (frame.id === undefined || typeof frame.method !== 'string') {
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
      answer({ error: error.message });
    }
  }

  private async _handleRequest(method: string, params: any): Promise<unknown> {
    switch (method) {
      case 'tabs.list':
        return { tabs: await this._listTabs() } satisfies ControlRequests['tabs.list']['result'];
      case 'session.open':
        return await this._openSession(params as ControlRequests['session.open']['params']);
      case 'session.claim':
        return await this._claimTab(params as ControlRequests['session.claim']['params']);
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

  private async _openSession({ ticket, clientName }: ControlRequests['session.open']['params']): Promise<ControlRequests['session.open']['result']> {
    const { serverUrl } = this._settings!;
    const channel = await Channel.open(`${serverUrl}${SESSION_PATH}?ticket=${encodeURIComponent(ticket)}`);
    const session = new ClientSession(channel, this._registry, { clientName, tabGroup: { title: TAB_GROUP_TITLE }, background: true });
    const sessionId = ++this._lastSessionId;

    this._sessions.set(sessionId, session);
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

  private async _claimTab({ sessionId, tabId }: ControlRequests['session.claim']['params']): Promise<Record<string, never>> {
    const session = this._sessions.get(sessionId);

    if (!session) {
      throw new Error(`No session ${sessionId}`);
    }

    const tab = await chrome.tabs.get(tabId);

    if (!isDebuggableUrl(tab.url ?? tab.pendingUrl)) {
      throw new Error('This tab cannot be controlled: it shows a page of the browser itself');
    }

    this._registry.claim(tab, session);

    return {};
  }

  private _didChangeSessions(): void {
    // Chrome starts a stopped worker for every event that has a listener, so
    // the tab and debugger listeners are on only while a session needs them.
    this._listeners.setEnabled(this._sessions.size > 0);
  }

  private _closeSessions(reason: string): void {
    for (const session of [...this._sessions.values()]) {
      session.close(reason);
    }
  }

  private _closeEverything(reason: string): void {
    clearTimeout(this._retryTimer);
    clearInterval(this._pingTimer);
    this._closeSessions(reason);

    const socket = this._socket;

    this._socket = undefined;
    this._welcomed = false;
    setReportSink(undefined);
    socket?.close(1000, reason);
  }
}

function parseFrame(data: unknown): Frame | null {
  try {
    const frame: unknown = JSON.parse(String(data));

    return frame && typeof frame === 'object' ? (frame as Frame) : null;
  } catch {
    return null;
  }
}
