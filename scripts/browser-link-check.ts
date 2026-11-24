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
// gets its status; a page of another origin does not; the options page
// shows the state.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { buildBrowserExtension } from '../build/browser-extension.js';
import type { PageStatus } from '../src/browser-link/protocol.ts';

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

async function main(): Promise<void> {
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'browser-link-check-'));
  const extensionDir = path.join(workDir, 'extension');
  const built = await buildBrowserExtension({
    consoleOrigin: CONSOLE_ORIGIN,
    // Nothing listens there: an unpaired extension dials nobody.
    serverUrl: 'ws://127.0.0.1:9',
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

    const status = (await withTimeout(
      consolePage.evaluate(id => chrome.runtime!.sendMessage!(id, { type: 'status' }), extensionId),
      10_000,
      'the status for the console page',
    )) as PageStatus;

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
  } finally {
    await userBrowser.close();
    await rm(workDir, { recursive: true, force: true });
  }

  console.log('\nThe browser link works on this host.');
}

main().catch(error => {
  console.error(`\nFAILED: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  process.exit(1);
});
