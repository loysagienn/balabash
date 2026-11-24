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
import { createBrowserLinkHub } from './hub.ts';
import type { BrowserLinkHub } from './hub.ts';
import { createPairings } from './pairings.ts';
import { EXTENSION_ID, compareVersions } from './protocol.ts';
import type { HelloParams } from './protocol.ts';
import {
  assertBrowserNameFree,
  browserName,
  browserWorkspaces,
  deleteBrowser,
  disableBrowser,
  enableBrowser,
  findBrowserBySecret,
  listBrowsers,
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

    const { browser, secret, replacedId } = await pairBrowser({ ...pairing, previousSecret: hello.previousSecret }).catch(error => {
      // The name was taken while the code waited: the user asks again.
      console.warn(`[browser-link] a pairing made no browser: ${error instanceof Error ? error.message : String(error)}`);

      return { browser: null, secret: '', replacedId: null };
    });

    if (!browser) {
      return null;
    }

    if (replacedId) {
      hub?.revoke(replacedId);
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
