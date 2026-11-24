// The browser a Playwright client sees through a session link: browser-level
// CDP on one side, the five commands of the extension on the other.
//
// Playwright's connectOverCDP speaks to a browser endpoint: it turns on
// auto-attach, creates and closes targets, and sends everything else into
// the session of a tab. An extension has no browser endpoint — only
// chrome.debugger on single tabs — so this model plays the browser: it
// knows the tabs the extension announced, attaches the debugger to each and
// invents the session id Playwright uses for it.
//
// The logic follows the relay model of Playwright's own extension mode
// (packages/playwright-core/src/tools/mcp/browserModel.ts and cdpRelayV2.ts,
// Apache-2.0), which is internal to its bundle and bound to a local browser.
//
// One thing is the model's own. A session's tabs live in the background of
// the user's window, and Chrome hides a background page and slows it down:
// no animation frames, timers once a second — while Playwright's actions
// wait for a frame to see that an element stands still. So the model turns
// on focus emulation on every tab it attaches to: the page lives as if it
// were in front without being brought there. Playwright does this itself
// for the browsers it launches, but not for the default context of a
// browser it connected to with `noDefaults` — which is how a user's own
// browser is connected, so that the rest of the page stays the user's.

export type CdpMessage = {
  id?: number;
  sessionId?: string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { message: string };
};

type TargetInfo = { targetId?: string } & Record<string, unknown>;

type TabSession = {
  tabId: number;
  sessionId: string;
  targetInfo: TargetInfo | undefined;
  // Sessions of the tab's child targets (frames, workers), named by Chrome.
  childSessions: Set<string>;
};

export type CdpModel = {
  // An event of the session link.
  handleExtensionEvent(method: string, params: unknown[]): void;
  // A command of the Playwright client; the value is its result.
  handleCommand(method: string, params: Record<string, unknown> | undefined, sessionId: string | undefined): Promise<unknown>;
  // Where the model's own CDP events go; null while no client is attached.
  setClient(send: ((message: CdpMessage) => void) | null): void;
};

export function createCdpModel(sendToExtension: (method: string, params: unknown[]) => Promise<unknown>): CdpModel {
  let sendToClient: ((message: CdpMessage) => void) | null = null;
  const knownTabs = new Set<number>();
  const tabSessions = new Map<number, TabSession>();
  let autoAttach = false;
  let nextSessionId = 1;

  const emit = (message: CdpMessage) => sendToClient?.(message);

  const findTabSession = (predicate: (session: TabSession) => boolean): TabSession | undefined => {
    for (const session of tabSessions.values()) {
      if (predicate(session)) {
        return session;
      }
    }

    return undefined;
  };

  const attachTab = async (tabId: number): Promise<TabSession> => {
    const existing = tabSessions.get(tabId);

    if (existing) {
      return existing;
    }

    await sendToExtension('chrome.debugger.attach', [{ tabId }, '1.3']);

    const answer = (await sendToExtension('chrome.debugger.sendCommand', [{ tabId }, 'Target.getTargetInfo'])) as
      | { targetInfo?: TargetInfo }
      | undefined;
    const targetInfo = answer?.targetInfo;
    const tabSession: TabSession = { tabId, sessionId: `tab-${nextSessionId++}`, targetInfo, childSessions: new Set() };

    // See the header: a background tab must not be a sleeping one.
    await sendToExtension('chrome.debugger.sendCommand', [{ tabId }, 'Emulation.setFocusEmulationEnabled', { enabled: true }]).catch(error =>
      console.warn(`[browser-link] focus emulation was not turned on for tab ${tabId}:`, error),
    );

    tabSessions.set(tabId, tabSession);
    emit({
      method: 'Target.attachedToTarget',
      params: { sessionId: tabSession.sessionId, targetInfo: { ...targetInfo, attached: true }, waitingForDebugger: false },
    });

    return tabSession;
  };

  const detachTab = (tabId: number) => {
    const tabSession = tabSessions.get(tabId);

    if (!tabSession) {
      return;
    }

    tabSessions.delete(tabId);
    emit({
      method: 'Target.detachedFromTarget',
      params: { sessionId: tabSession.sessionId, targetId: tabSession.targetInfo?.targetId },
    });
  };

  const attachQuietly = (tabId: number) =>
    attachTab(tabId).catch(error => console.warn(`[browser-link] could not attach to tab ${tabId}:`, error));

  // A command with no tab of its own (Storage.*, Browser.*): the debugger
  // API needs a target, and the answer is the same through any tab.
  const sendBrowserCommand = (method: string, params: Record<string, unknown> | undefined) => {
    const tabSession = tabSessions.values().next().value;

    if (!tabSession) {
      throw new Error(`No attached tab to carry the browser-level command ${method}`);
    }

    return sendToExtension('chrome.debugger.sendCommand', [{ tabId: tabSession.tabId }, method, params]);
  };

  const sendTabCommand = (sessionId: string, method: string, params: Record<string, unknown> | undefined) => {
    const own = findTabSession(session => session.sessionId === sessionId);
    const tabSession = own ?? findTabSession(session => session.childSessions.has(sessionId));

    if (!tabSession) {
      throw new Error(`No tab for the session ${sessionId}`);
    }

    const target = own ? { tabId: tabSession.tabId } : { tabId: tabSession.tabId, sessionId };

    return sendToExtension('chrome.debugger.sendCommand', [target, method, params]);
  };

  return {
    setClient(send) {
      sendToClient = send;
    },

    handleExtensionEvent(method, params) {
      switch (method) {
        case 'chrome.tabs.onCreated': {
          const tabId = (params[0] as { id?: number } | undefined)?.id;

          if (tabId === undefined) {
            return;
          }

          knownTabs.add(tabId);

          if (autoAttach) {
            void attachQuietly(tabId);
          }

          return;
        }

        case 'chrome.tabs.onRemoved': {
          const tabId = params[0] as number;

          knownTabs.delete(tabId);
          detachTab(tabId);

          return;
        }

        case 'chrome.debugger.onDetach': {
          const tabId = (params[0] as { tabId?: number } | undefined)?.tabId;

          if (tabId !== undefined) {
            detachTab(tabId);
          }

          return;
        }

        case 'chrome.debugger.onEvent': {
          const [source, cdpMethod, cdpParams] = params as [
            { tabId?: number; sessionId?: string },
            string,
            Record<string, unknown> | undefined,
          ];
          const tabSession = source.tabId === undefined ? undefined : tabSessions.get(source.tabId);

          if (!tabSession) {
            return;
          }

          const childSessionId = typeof cdpParams?.sessionId === 'string' ? cdpParams.sessionId : undefined;

          if (cdpMethod === 'Target.attachedToTarget' && childSessionId) {
            tabSession.childSessions.add(childSessionId);
          } else if (cdpMethod === 'Target.detachedFromTarget' && childSessionId) {
            tabSession.childSessions.delete(childSessionId);
          }

          emit({ sessionId: source.sessionId || tabSession.sessionId, method: cdpMethod, params: cdpParams });

          return;
        }
      }
    },

    async handleCommand(method, params, sessionId) {
      switch (method) {
        // The relay is the browser endpoint; the extension has none to ask.
        case 'Browser.getVersion':
          return { protocolVersion: '1.3', product: 'Chrome/Extension-Bridge', userAgent: 'CDP-Bridge-Server/1.0.0' };

        case 'Browser.setDownloadBehavior':
          return {};

        case 'Target.setAutoAttach': {
          if (sessionId) {
            break;
          }

          autoAttach = true;
          await Promise.all([...knownTabs].map(attachQuietly));

          return {};
        }

        case 'Target.createTarget': {
          const tab = (await sendToExtension('chrome.tabs.create', [{ url: params?.url, active: false }])) as
            | { id?: number }
            | undefined;

          if (tab?.id === undefined) {
            throw new Error('The browser did not create a tab');
          }

          knownTabs.add(tab.id);

          return { targetId: (await attachTab(tab.id)).targetInfo?.targetId };
        }

        case 'Target.closeTarget': {
          const tabSession = findTabSession(session => session.targetInfo?.targetId === params?.targetId);

          if (!tabSession) {
            return { success: false };
          }

          await sendToExtension('chrome.tabs.remove', [tabSession.tabId]);

          return { success: true };
        }

        case 'Target.getTargetInfo':
          return sessionId ? findTabSession(session => session.sessionId === sessionId)?.targetInfo : undefined;
      }

      return sessionId ? sendTabCommand(sessionId, method, params) : sendBrowserCommand(method, params);
    },
  };
}
