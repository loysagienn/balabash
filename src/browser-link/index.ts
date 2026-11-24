// The link to users' own browsers, as the app runs it: the hub on the app's
// HTTP server (hub.ts), the browsers and their pairings in the database
// (store.ts, pairings.ts), and what the console does with them — every
// change of a browser goes through here, so that the link of a connected
// browser and the open consoles follow it at once.
//
// Who a `hello` is: a pairing code makes the browser and its secret; a
// secret finds its row. A browser the console disconnected is nobody at
// once — its link closes with the code that makes the extension forget the
// secret.
//
// An agent of a workspace reaches the browsers enabled in that workspace,
// whoever owns them: it lists them, reads the tabs of one and opens a
// session in it — the session link of the hub behind a CDP endpoint on
// loopback (relay.ts) a Playwright client connects to. A session whose
// agent is idle is parked and comes back behind a new endpoint (hub.ts). A
// browser disabled in a workspace or disconnected takes its sessions with
// it at once, the parked ones too, and the ones that are on their way into
// parking or back: the right of a session to its browser is one record for
// its whole life (Hold). A browser whose extension is older than the one
// that holds every boundary (SESSIONS_SINCE_VERSION) is linked and shown,
// but an agent gets neither its tabs nor a session in it.
//
// What is connected now is the hub's memory; connections are not journaled.
// The consoles learn of a change — a browser came or went, was paired,
// renamed, enabled, disabled, disconnected — by an ephemeral signal
// (browserSignals → the `browsers` frame of the event stream,
// src/api/event-stream.ts) that says "the list changed": the receiver reads
// the list itself.

import fs from 'node:fs/promises';
import type { Server } from 'node:http';
import path from 'node:path';
import { config } from '../config/index.ts';
import { prisma } from '../db/client.ts';
import { createBrowserLinkHub } from './hub.ts';
import type { BrowserLinkHub, ConnectedBrowser, ExtensionSession, ParkedSession, SessionEnd } from './hub.ts';
import { createPairings } from './pairings.ts';
import { EXTENSION_ID, SESSIONS_SINCE_VERSION, compareVersions } from './protocol.ts';
import type { BrowserTab, HelloParams, SessionNotice } from './protocol.ts';
import { startCdpRelay } from './relay.ts';
import {
  assertBrowserNameFree,
  browserName,
  browserWorkspaces,
  deleteBrowser,
  disableBrowser,
  enableBrowser,
  findBrowserBySecret,
  isBrowserEnabled,
  listBrowsers,
  listWorkspaceBrowsers,
  pairBrowser,
  recordBrowserSeen,
  renameBrowser,
} from './store.ts';
import type { BrowserRecord } from './store.ts';

export { BrowserError } from './store.ts';

const EXTENSION_DIR = path.resolve('dist', 'browser-extension');
// The archive of the extension the console hands out (build/browser-extension.js).
export const EXTENSION_ARCHIVE = `${EXTENSION_DIR}.zip`;

// --------------------------------------------------------------------------
// The signals: in-process, ephemeral, one listener per open event stream.
// A change of a browser reaches the streams of its owner — in any workspace,
// the owner sees all of their browsers — and the streams of the workspaces
// the browser is enabled in.

export type BrowserSignal = { userId: string; workspaceIds: string[] };

export type BrowserSignals = {
  notify(signal: BrowserSignal): void;
  subscribe(userId: string, workspaceId: string, listener: () => void): () => void;
};

export function createBrowserSignals(): BrowserSignals {
  const listeners = new Set<{ userId: string; workspaceId: string; listener: () => void }>();

  return {
    notify(signal) {
      for (const entry of listeners) {
        if (entry.userId === signal.userId || signal.workspaceIds.includes(entry.workspaceId)) {
          try {
            entry.listener();
          } catch (error) {
            console.error('[browser-link] signal listener failed:', error);
          }
        }
      }
    },
    subscribe(userId, workspaceId, listener) {
      const entry = { userId, workspaceId, listener };

      listeners.add(entry);

      return () => {
        listeners.delete(entry);
      };
    },
  };
}

export const browserSignals: BrowserSignals = createBrowserSignals();

// Fire-and-forget: never throws. `workspaceIds` — the workspaces the browser
// was enabled in when they are not what the rows say any more.
function signal(browser: Pick<BrowserRecord, 'id' | 'userId'>, workspaceIds?: string[]): void {
  Promise.resolve(workspaceIds ?? browserWorkspaces(browser.id))
    .then(ids => browserSignals.notify({ userId: browser.userId, workspaceIds: ids }))
    .catch(error => console.error('[browser-link] signal failed:', error));
}

// --------------------------------------------------------------------------
// The extension this installation builds.

let cachedVersion: { mtimeMs: number; version: string } | null = null;

// The version of the built extension; null when the installation has built
// none (the build skips it without a console domain).
export async function extensionVersion(): Promise<string | null> {
  const manifestPath = path.join(EXTENSION_DIR, 'manifest.json');
  const stats = await fs.stat(manifestPath).catch(() => null);

  if (!stats) {
    return null;
  }

  if (cachedVersion?.mtimeMs !== stats.mtimeMs) {
    try {
      const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as { version?: unknown };

      cachedVersion = { mtimeMs: stats.mtimeMs, version: typeof manifest.version === 'string' ? manifest.version : '' };
    } catch (error) {
      console.error('[browser-link] failed to read the manifest of the extension:', error);

      return null;
    }
  }

  return cachedVersion.version || null;
}

// --------------------------------------------------------------------------
// The hub.

const pairings = createPairings();
let hub: BrowserLinkHub | null = null;

async function admit(hello: HelloParams) {
  if ('pairingCode' in hello) {
    const pairing = pairings.redeem(hello.pairingCode);

    if (!pairing) {
      return null;
    }

    const { browser, secret, replaced } = await pairBrowser({ ...pairing, previousSecret: hello.previousSecret }).catch(error => {
      // The name was taken while the code waited: the user asks again.
      console.warn(`[browser-link] a pairing made no browser: ${error instanceof Error ? error.message : String(error)}`);

      return { browser: null, secret: '', replaced: null };
    });

    if (!browser) {
      return null;
    }

    if (replaced) {
      hub?.revoke(replaced.id);
      // The row is gone: its owner and the workspaces it was enabled in are
      // told by what the pairing remembered of it.
      signal(replaced, replaced.workspaceIds);
    }

    await recordBrowserSeen(browser.id, hello.extensionVersion);

    return { browserId: browser.id, name: browser.name, secret };
  }

  const known = await findBrowserBySecret(hello.secret);
  const browser = known && (await recordBrowserSeen(known.id, hello.extensionVersion));

  return browser ? { browserId: browser.id, name: browser.name } : null;
}

// Puts the hub on the server: the upgrade requests of the server are the
// hub's or nobody's. Answers what stops it.
export function startBrowserLink(server: Server): () => void {
  const started = createBrowserLinkHub({
    admit,
    extensionVersion: async () => (await extensionVersion()) ?? '',
    host: config.consoleDomain,
    origin: `chrome-extension://${EXTENSION_ID}`,
  });

  started.onPresence = (browserId, connected) => {
    console.log(`[browser-link] browser ${browserId} ${connected ? 'connected' : 'is gone'}`);
    // Null — the row is gone: a disconnected browser, signalled by whoever disconnected it.
    recordBrowserSeen(browserId)
      .then(browser => browser && signal(browser))
      .catch(error => console.error('[browser-link] presence was not recorded:', error));
  };
  started.onReport = (browserId, text) => console.warn(`[browser-link] browser ${browserId} reports: ${text}`);

  const onUpgrade = (request: Parameters<BrowserLinkHub['handleUpgrade']>[0], socket: Parameters<BrowserLinkHub['handleUpgrade']>[1], head: Buffer) => {
    if (!started.handleUpgrade(request, socket, head)) {
      socket.destroy();
    }
  };

  server.on('upgrade', onUpgrade);
  hub = started;

  return () => {
    server.off('upgrade', onUpgrade);
    started.close();

    if (hub === started) {
      hub = null;
    }
  };
}

// --------------------------------------------------------------------------
// What the console does with browsers. A user acts on their own browsers
// only: the store refuses the rest as `not_found`.

export { listBrowsers } from './store.ts';
export type { BrowserListing, BrowserRecord } from './store.ts';

export function isBrowserConnected(browserId: string): boolean {
  return hub?.browser(browserId) != null;
}

// The browser's extension is older than the one this installation builds.
export async function isBrowserOutdated(browser: Pick<BrowserRecord, 'extensionVersion'>): Promise<boolean> {
  const current = await extensionVersion();

  return Boolean(current && browser.extensionVersion && compareVersions(browser.extensionVersion, current) < 0);
}

// A pairing code for the browser the console is open in: the page hands it
// to the extension, and the extension's `hello` brings it back.
export async function requestBrowserPairing(userId: string, workspaceId: string, name: unknown): Promise<{ code: string; expiresAt: Date }> {
  const clean = browserName(name);

  await assertBrowserNameFree(userId, clean);

  return pairings.issue({ userId, workspaceId, name: clean });
}

export async function renameUserBrowser(userId: string, browserId: string, name: unknown): Promise<BrowserRecord> {
  const browser = await renameBrowser(userId, browserId, name);

  hub?.renamed(browserId, browser.name);
  signal(browser);

  return browser;
}

export async function enableUserBrowser(userId: string, browserId: string, workspaceId: string): Promise<BrowserRecord> {
  const browser = await enableBrowser(userId, browserId, workspaceId);

  signal(browser);

  return browser;
}

export async function disableUserBrowser(userId: string, browserId: string, workspaceId: string): Promise<BrowserRecord> {
  const browser = await disableBrowser(userId, browserId, workspaceId);

  closeSessions(browserId, workspaceId);
  signal(browser, [...(await browserWorkspaces(browserId)), workspaceId]);

  return browser;
}

// For good: the row and the secret are gone, and the link closes at once.
export async function disconnectUserBrowser(userId: string, browserId: string): Promise<BrowserRecord> {
  const { browser, workspaceIds } = await deleteBrowser(userId, browserId);

  hub?.revoke(browserId);
  signal(browser, workspaceIds);

  return browser;
}

// --------------------------------------------------------------------------
// What an agent of a workspace does with browsers. It reaches the browsers
// enabled in its workspace and no other.

export { BrowserRequestError } from './hub.ts';
export type { SessionEnd } from './hub.ts';
export type { BrowserTab, ControlRefusal, SessionNotice } from './protocol.ts';

export type WorkspaceBrowser = {
  id: string;
  name: string;
  // The display name of the user who linked the browser.
  ownerName: string | null;
  connected: boolean;
  lastSeenAt: Date | null;
};

// Why an agent did not get to a browser: it is not enabled in the workspace
// (or does not exist — the same to the agent); its extension is not on the
// link now; its extension is older than the one an agent works through
// (SESSIONS_SINCE_VERSION).
export type BrowserAccessErrorCode = 'not_enabled' | 'offline' | 'outdated';

export class BrowserAccessError extends Error {
  code: BrowserAccessErrorCode;

  constructor(code: BrowserAccessErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export async function workspaceBrowsers(workspaceId: string): Promise<WorkspaceBrowser[]> {
  return (await listWorkspaceBrowsers(workspaceId)).map(browser => ({
    id: browser.id,
    name: browser.name,
    ownerName: browser.ownerName,
    connected: isBrowserConnected(browser.id),
    lastSeenAt: browser.lastSeenAt,
  }));
}

async function reach(workspaceId: string, browserId: string): Promise<ConnectedBrowser> {
  if (!(await isBrowserEnabled(browserId, workspaceId))) {
    throw new BrowserAccessError('not_enabled', 'This browser is not enabled in the workspace');
  }

  const connected = hub?.browser(browserId);

  if (!connected) {
    throw new BrowserAccessError('offline', 'This browser is not connected now');
  }

  if (compareVersions(connected.extensionVersion, SESSIONS_SINCE_VERSION) < 0) {
    throw new BrowserAccessError('outdated', `The extension of this browser is older than ${SESSIONS_SINCE_VERSION}`);
  }

  return connected;
}

// The tabs the user has open, as the extension lists them — no session and
// no debugger.
export async function workspaceBrowserTabs(workspaceId: string, browserId: string): Promise<BrowserTab[]> {
  return await (await reach(workspaceId, browserId)).listTabs();
}

// A session of an agent in a browser, as its Playwright client sees it.
export type BrowserSession = {
  browserId: string;
  // ws://127.0.0.1:<port>/cdp/<id> — for chromium.connectOverCDP.
  endpoint: string;
  // Asks the user for one of their tabs; resolves once they agreed, rejects
  // with a BrowserRequestError that carries the code of the refusal.
  claimTab(tabId: number): Promise<void>;
  // Hears what the extension did to the session by the user's rules.
  onNotice(listener: (notice: SessionNotice) => void): void;
  // The tabs of the session, in the order its client numbers them.
  tabIds(): number[];
  // Parks the session while its agent is idle: the debugger leaves its tabs
  // and the endpoint closes; the group of tabs stays the session's. A
  // refusal ends the session as lost.
  park(): Promise<ParkedBrowserSession>;
  // Settles once, when the session is over: how, and what was said about it.
  ended: Promise<{ end: SessionEnd; detail: string }>;
  // The agent is done with the session; its tabs stay open in the browser.
  close(): Promise<void>;
};

// A session parked in a browser: no endpoint, no debugger, its group of
// tabs kept for its return.
export type ParkedBrowserSession = {
  browserId: string;
  // Settles once if the session ended before it came back: the user stopped
  // it, the browser's access was withdrawn, the link was lost.
  ended: Promise<{ end: SessionEnd; detail: string }>;
  // The session comes back behind a new endpoint with the tabs of its group
  // — the ones of `tabIds` first, in that order (the order of
  // BrowserSession.tabIds before the parking). A failure ends it.
  resume(options: { clientName: string; label: string; tabIds: number[] }): Promise<BrowserSession>;
  // The agent is done with the session.
  close(): void;
};

// The right of one session to its browser, for as long as the session lives
// — open, parked, or on its way between the two. A withdrawal is for good
// and reaches the session in whatever form it has: one that is changing its
// form finds the withdrawal waiting when it has changed.
export type Hold = {
  withdrawn: boolean;
  // Ends the session in the form it has now.
  end(): void;
  // Whether the workspace of the session has the browser still.
  allowed(): Promise<boolean>;
  // The session is over.
  forget(): void;
};

// The sessions that live now, with the workspace each was opened from.
const heldSessions = new Set<{ browserId: string; workspaceId: string; hold: Hold }>();

// A hold nobody withdraws: a session opened past the workspaces (a stand).
const freeHold = (): Hold => ({ withdrawn: false, end: () => {}, allowed: async () => true, forget: () => {} });

// The browser is no longer the workspace's: the sessions opened from it end.
function closeSessions(browserId: string, workspaceId: string): void {
  for (const entry of [...heldSessions]) {
    if (entry.browserId === browserId && entry.workspaceId === workspaceId) {
      entry.hold.withdrawn = true;
      entry.hold.end();
    }
  }
}

// What the user reads about a session in their browser: the workspace, when
// it has a name, and the title of the agent's thread.
export async function sessionLabel(workspaceId: string, threadTitle: string): Promise<string> {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { workspaceName: true } });

  return [workspace?.workspaceName, threadTitle].filter(Boolean).join(' — ');
}

export async function openBrowserSession(options: {
  workspaceId: string;
  browserId: string;
  // Names the client to the extension.
  clientName: string;
  label: string;
}): Promise<BrowserSession> {
  const { workspaceId, browserId } = options;
  const entry = {
    browserId,
    workspaceId,
    hold: {
      withdrawn: false,
      end: () => {},
      allowed: () => isBrowserEnabled(browserId, workspaceId),
      forget: () => void heldSessions.delete(entry),
    } as Hold,
  };
  const { hold } = entry;

  // Held from before it is open: a withdrawal meanwhile waits for it.
  heldSessions.add(entry);

  let session: ExtensionSession;

  try {
    session = await (await reach(workspaceId, browserId)).openSession({ clientName: options.clientName, label: options.label });
  } catch (error) {
    hold.forget();

    throw error;
  }

  const relayed = await relaySession(browserId, session, hold);

  // Disabled while the session was opening.
  if (hold.withdrawn || !(await hold.allowed())) {
    session.close('revoked');

    throw new BrowserAccessError('not_enabled', 'This browser is not enabled in the workspace');
  }

  return relayed;
}

const WITHDRAWN: { end: SessionEnd; detail: string } = { end: 'revoked', detail: 'Access to the browser was withdrawn' };

// A session of the hub as a Playwright client and an agent's run use it:
// behind a CDP endpoint on loopback. `hold` is the session's right to the
// browser, which follows it through parking and back.
export async function relaySession(browserId: string, session: ExtensionSession, hold: Hold = freeHold()): Promise<BrowserSession> {
  // The session left this form to be parked: its end here is not its end.
  let parking = false;

  hold.end = () => session.close('revoked');
  void session.ended.then(() => {
    if (!parking) {
      hold.forget();
    }
  });

  if (hold.withdrawn) {
    session.close('revoked');
  }

  const relay = await startCdpRelay(session).catch(error => {
    session.close();

    throw error;
  });

  const park = async (): Promise<ParkedBrowserSession> => {
    let parked: ParkedSession;

    parking = true;

    try {
      parked = await relay.park();
    } catch (error) {
      // The refusal ended the session.
      hold.forget();

      throw error;
    }

    // How it ended when it was on its way back that it ended.
    let fail!: (outcome: { end: SessionEnd; detail: string }) => void;
    const ended = Promise.race([
      parked.ended,
      new Promise<{ end: SessionEnd; detail: string }>(resolve => {
        fail = resolve;
      }),
    ]);
    // True once the session came back: the hold is the open session's again.
    let back = false;

    void ended.then(() => {
      if (!back) {
        hold.forget();
      }
    });
    hold.end = () => parked.close('revoked');

    // Withdrawn while it was being parked.
    if (hold.withdrawn) {
      parked.close('revoked');
    }

    return {
      browserId,
      ended,
      resume: async options => {
        // Between the two the session is neither parked nor open: a
        // withdrawal waits in the hold for the one that comes back.
        hold.end = () => {};

        try {
          if (hold.withdrawn || !(await hold.allowed())) {
            parked.close('revoked');
            fail(WITHDRAWN);

            throw new BrowserAccessError('not_enabled', 'This browser is not enabled in the workspace');
          }

          const returned = await parked.resume(options);

          if (hold.withdrawn || !(await hold.allowed())) {
            returned.close('revoked');
            fail(WITHDRAWN);

            throw new BrowserAccessError('not_enabled', 'This browser is not enabled in the workspace');
          }

          back = true;

          return await relaySession(browserId, returned, hold);
        } catch (error) {
          // The link has said how already, when it was the link that failed.
          fail({ end: 'lost', detail: error instanceof Error ? error.message : String(error) });

          throw error;
        }
      },
      close: () => parked.close(),
    };
  };

  return {
    browserId,
    endpoint: relay.endpoint,
    claimTab: tabId => session.claimTab(tabId),
    onNotice: listener => {
      session.onNotice = listener;
    },
    tabIds: relay.tabIds,
    park,
    ended: session.ended,
    close: relay.close,
  };
}
