// End-to-end check of the browser link on this host, without a user's
// machine: a Chromium with the extension plays the user's browser.
//
//   node scripts/browser-link-check.ts
//
// The extension is built here for a stand of its own (a console origin that
// exists only inside this Chromium, into a temporary directory), so the
// check needs no installation and touches neither the app nor its
// database. Each step prints a line; the first failure ends the run with a
// non-zero exit code.
//
// What it covers: a page of the console origin reaches the extension and
// gets its status, a page of another origin does not; the page hands a
// pairing code over and the extension pairs through the hub
// (src/browser-link/hub.ts, run in this process with the script's own
// memory for a database) — a refused code first, then a good one; the tabs
// are listed over the link; the options page shows the name and the state;
// the pause drops the link and its end brings it back; a link the server
// dropped is dialed again; a refused re-pairing leaves the browser paired;
// a revoked browser forgets its secret and stays away.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { buildBrowserExtension } from '../build/browser-extension.js';
import { createBrowserLinkHub } from '../src/browser-link/hub.ts';
import type { Admission } from '../src/browser-link/hub.ts';
import { EXTENSION_ID } from '../src/browser-link/protocol.ts';
import type { PagePairResult, PageStatus } from '../src/browser-link/protocol.ts';

// The functions passed to a page run there, where `chrome` is.
declare const chrome: { runtime?: { sendMessage?(extensionId: string, message: unknown): Promise<unknown> } };

const CONSOLE_ORIGIN = 'https://console.browser-link.test';
const OTHER_ORIGIN = 'https://elsewhere.browser-link.test';

const step = (text: string) => console.log(`ok  ${text}`);

async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out: ${what}`)), ms);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function until(what: string, condition: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;

  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out: ${what}`);
    }

    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

async function main(): Promise<void> {
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'browser-link-check-'));
  const extensionDir = path.join(workDir, 'extension');

  // The server's side: the hub, with this script's memory for a database —
  // one pairing code, and the browser it makes.
  const BROWSER_ID = 'check-browser';
  const GOOD_CODE = 'the-good-code';
  let secret = '';
  let codeUsed = false;
  const hub = createBrowserLinkHub({
    admit: async (hello): Promise<Admission | null> => {
      if ('pairingCode' in hello) {
        if (hello.pairingCode !== GOOD_CODE || codeUsed) {
          return null;
        }

        codeUsed = true;
        secret = `secret-${Date.now()}`;

        return { browserId: BROWSER_ID, name: 'Check browser', secret };
      }

      return secret && hello.secret === secret ? { browserId: BROWSER_ID, name: 'Check browser' } : null;
    },
    extensionVersion: async () => '0.0.1',
    // The stand is reached by its loopback address; the origin is the extension's, as in the app.
    host: null,
    origin: `chrome-extension://${EXTENSION_ID}`,
  });
  const server = http.createServer((_request, response) => response.writeHead(404).end());
  // The connections that became links: the server forgets an upgraded one.
  const upgraded = new Set<import('node:stream').Duplex>();

  server.on('upgrade', (request, socket, head) => {
    upgraded.add(socket);
    socket.once('close', () => upgraded.delete(socket));

    if (!hub.handleUpgrade(request, socket, head)) {
      socket.destroy();
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));

  const built = await buildBrowserExtension({
    consoleOrigin: CONSOLE_ORIGIN,
    serverUrl: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
    outDir: extensionDir,
  });
  const manifest = JSON.parse(await readFile(path.join(extensionDir, 'manifest.json'), 'utf8')) as { version: string };

  assert.equal(built.version, manifest.version);
  step(`the extension ${built.version} is built with its archive (${path.basename(built.archive)})`);

  // The user's browser: a profile with the extension.
  const userBrowser = await chromium.launchPersistentContext(path.join(workDir, 'profile'), {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
  });

  try {
    // The stand's origins exist only here.
    await userBrowser.route(/^https:\/\/(console|elsewhere)\.browser-link\.test\//, route =>
      route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<title>Stand page</title><h1>Stand page</h1>' }),
    );

    const worker = userBrowser.serviceWorkers()[0] ?? (await withTimeout(userBrowser.waitForEvent('serviceworker'), 15_000, 'the extension worker'));
    const extensionId = new URL(worker.url()).host;

    step(`the extension is loaded (${worker.url()})`);

    const consolePage = userBrowser.pages()[0] ?? (await userBrowser.newPage());

    await consolePage.goto(`${CONSOLE_ORIGIN}/connections`);

    const ask = <T>(message: unknown) =>
      withTimeout(
        consolePage.evaluate(([id, body]) => chrome.runtime!.sendMessage!(id as string, body), [extensionId, message]),
        20_000,
        `the answer to ${JSON.stringify(message)}`,
      ) as Promise<T>;
    const status = await ask<PageStatus>({ type: 'status' });

    assert.equal(extensionId, EXTENSION_ID);
    assert.deepEqual(status, { version: manifest.version, state: 'unpaired', browserId: null });
    step(`a page of the console origin gets the status: ${JSON.stringify(status)}`);

    const otherPage = await userBrowser.newPage();

    await otherPage.goto(`${OTHER_ORIGIN}/`);

    const refused = await otherPage.evaluate(async id => {
      if (!chrome.runtime?.sendMessage) {
        return 'no chrome.runtime.sendMessage on the page';
      }

      try {
        return `answered: ${JSON.stringify(await chrome.runtime.sendMessage(id, { type: 'status' }))}`;
      } catch (error) {
        return `refused: ${String(error)}`;
      }
    }, extensionId);

    assert.ok(!refused.startsWith('answered'), refused);
    step(`a page of another origin does not reach the extension (${refused})`);

    const optionsPage = await userBrowser.newPage();

    await optionsPage.goto(`chrome-extension://${extensionId}/options.html`);
    await optionsPage.locator('#status[data-state="unpaired"]').waitFor({ timeout: 10_000 });
    assert.equal(await optionsPage.locator('#console').getAttribute('href'), `${CONSOLE_ORIGIN}/`);
    assert.equal(await optionsPage.locator('#paused').isDisabled(), true);
    step(`the options page shows the state: ${JSON.stringify(await optionsPage.locator('#status').textContent())}`);

    // Pairing: the page hands the code over, the extension brings it in its hello.
    assert.deepEqual(await ask<PagePairResult>({ type: 'pair', code: 'not-the-code' }), { ok: false, error: 'code_rejected' });
    assert.equal((await ask<PageStatus>({ type: 'status' })).state, 'unpaired');
    step('a refused pairing code leaves the extension unpaired');

    assert.deepEqual(await ask<PagePairResult>({ type: 'pair', code: GOOD_CODE }), { ok: true, browserId: BROWSER_ID });
    assert.ok(hub.browser(BROWSER_ID), 'the hub holds the browser');
    assert.deepEqual(await ask<PageStatus>({ type: 'status' }), { version: manifest.version, state: 'connected', browserId: BROWSER_ID });
    step(`the page paired the extension: browser ${BROWSER_ID}, extension ${hub.browser(BROWSER_ID)!.extensionVersion}`);

    const tabs = await hub.browser(BROWSER_ID)!.listTabs();

    assert.ok(tabs.some(tab => tab.url.startsWith(CONSOLE_ORIGIN)), JSON.stringify(tabs));
    step(`tabs are listed over the link: ${tabs.map(tab => JSON.stringify(tab.title || tab.url)).join(', ')}`);

    await optionsPage.locator('#status[data-state="connected"]').waitFor({ timeout: 10_000 });
    assert.match((await optionsPage.locator('#status').textContent()) ?? '', /^Check browser — Connected\./);
    hub.renamed(BROWSER_ID, 'Renamed in the console');
    await optionsPage.locator('#status', { hasText: 'Renamed in the console' }).waitFor({ timeout: 10_000 });
    step('the options page shows the name the console gave, and its change');

    // The pause: no link while it lasts.
    await optionsPage.locator('#paused').check();
    await until('the paused extension leaves the link', () => !hub.browser(BROWSER_ID));
    assert.equal((await ask<PageStatus>({ type: 'status' })).state, 'paused');
    await optionsPage.locator('#paused').uncheck();
    await until('the extension comes back after the pause', () => Boolean(hub.browser(BROWSER_ID)));
    step('the pause drops the link, its end brings the browser back with its secret');

    // A link the server lost is dialed again.
    let dropped = false;

    hub.onPresence = (_id, connected) => {
      dropped ||= !connected;
    };
    // The network between them went away: no closing handshake.
    for (const socket of upgraded) {
      socket.destroy();
    }

    await until('the extension notices the dropped link and dials again', () => dropped && Boolean(hub.browser(BROWSER_ID)));
    step('a dropped link is dialed again');

    // A refused re-pairing is a refusal of the code, not of the browser.
    assert.deepEqual(await ask<PagePairResult>({ type: 'pair', code: GOOD_CODE }), { ok: false, error: 'code_rejected' });
    await until('the browser is back on the link with the secret it had', () => Boolean(hub.browser(BROWSER_ID)));
    assert.equal((await ask<PageStatus>({ type: 'status' })).browserId, BROWSER_ID);
    step('a refused re-pairing leaves the browser paired and brings it back');

    // Revoked: the browser forgets its secret and stays away.
    secret = '';
    hub.revoke(BROWSER_ID);
    await until('the revoked extension forgets its secret', async () => (await ask<PageStatus>({ type: 'status' })).state === 'unpaired');
    await new Promise(resolve => setTimeout(resolve, 3000));
    assert.equal(hub.browser(BROWSER_ID), null);
    assert.deepEqual(await ask<PageStatus>({ type: 'status' }), { version: manifest.version, state: 'unpaired', browserId: null });
    step('a revoked browser is unpaired and does not dial again');
  } finally {
    await userBrowser.close();
    hub.close();

    for (const socket of upgraded) {
      socket.destroy();
    }

    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(workDir, { recursive: true, force: true });
  }

  console.log('\nThe browser link works on this host.');
}

main().catch(error => {
  console.error(`\nFAILED: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  process.exit(1);
});
