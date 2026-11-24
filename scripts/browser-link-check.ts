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
// an agent's run works in the browser the way `user_browser` does
// (agents/kit/user-browser.ts over the hub and the relay, the tools of
// agents/kit/playwright.ts): the session is opened by the first browser
// call, in a background tab of its own group; navigation, snapshot, click,
// evaluation, screenshot and a file upload work; a second run holds its own
// session at the same time; a session that said nothing for a while
// (`--silence=<seconds>`, 90 by default) still works; the pause ends the
// sessions as stopped by the user and leaves their tabs open and free;
// the pause drops the link and its end brings it back; a link the server
// dropped is dialed again; a refused re-pairing leaves the browser paired;
// a revoked browser loses its session, forgets its secret and stays away.

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { connectPlaywrightMcp, createPlaywrightTools } from '../agents/kit/playwright.ts';
import { attachToSession, createUserBrowser } from '../agents/kit/user-browser.ts';
import type { UserBrowserLink } from '../agents/kit/user-browser.ts';
import { buildBrowserExtension } from '../build/browser-extension.js';
import { createBrowserLinkHub } from '../src/browser-link/hub.ts';
import type { Admission } from '../src/browser-link/hub.ts';
import { BrowserAccessError } from '../src/browser-link/index.ts';
import { EXTENSION_ID } from '../src/browser-link/protocol.ts';
import type { PagePairResult, PageStatus } from '../src/browser-link/protocol.ts';
import { startCdpRelay } from '../src/browser-link/relay.ts';

// The functions passed to a page run there, where `chrome` is.
declare const chrome: { runtime?: { sendMessage?(extensionId: string, message: unknown): Promise<unknown> } };

const CONSOLE_ORIGIN = 'https://console.browser-link.test';
const OTHER_ORIGIN = 'https://elsewhere.browser-link.test';

// How long a session keeps silent before it is used again.
const SILENCE_SECONDS = Number(process.argv.find(argument => argument.startsWith('--silence='))?.split('=')[1] ?? 90);

// The pages an agent works with, served by the stand.
const PAGES: Record<string, string> = {
  '/agent.html':
    '<title>Agent page</title><h1>Agent page</h1><button onclick="document.title=\'Pressed\'">Press me</button><input aria-label="Note" />',
  '/second.html': '<title>Second agent page</title><h1>Second agent page</h1>',
  '/upload.html':
    '<title>Upload page</title><h1>Upload page</h1><input type="file" aria-label="Attachment" ' +
    'onchange="this.files[0].text().then(text => { document.title = this.files[0].name + \': \' + text })" />',
};

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
  const server = http.createServer((request, response) => {
    const body = PAGES[new URL(request.url ?? '/', 'http://stand').pathname];

    response.writeHead(body ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' }).end(body ?? '');
  });
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

  const standOrigin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // An agent's run in the check's browser: what `user_browser` builds for
  // its session (agents/user_browser.ts), with the hub of this script for
  // the link.
  const runs: { close(): Promise<void> }[] = [];
  const startRun = async (name: string) => {
    const link: UserBrowserLink = {
      browsers: async () => [{ id: BROWSER_ID, name: 'Check browser', ownerName: 'Check user', connected: Boolean(hub.browser(BROWSER_ID)), lastSeenAt: null }],
      tabs: async () => {
        const connected = hub.browser(BROWSER_ID);

        if (!connected) {
          throw new BrowserAccessError('offline', 'This browser is not connected now');
        }

        return connected.listTabs();
      },
      open: async () => {
        const connected = hub.browser(BROWSER_ID);

        if (!connected) {
          throw new BrowserAccessError('offline', 'This browser is not connected now');
        }

        const session = await connected.openSession({ clientName: 'browser-link-check', label: name });
        const relay = await startCdpRelay(session);

        return { browserId: BROWSER_ID, endpoint: relay.endpoint, ended: session.ended, close: relay.close };
      },
      attach: attachToSession,
    };
    const userBrowser = createUserBrowser({ workspaceId: 'check', clientName: 'browser-link-check', label: async () => name, link });
    const cwd = path.join(workDir, name);
    const playwright = await connectPlaywrightMcp({ outputDir: path.join(cwd, 'output'), cwd, clientName: 'browser-link-check', context: userBrowser.context });
    const screenshots: Buffer[] = [];
    const tools = [
      ...userBrowser.tools(),
      ...(
        await createPlaywrightTools(playwright.client, async image => {
          screenshots.push(image.data);

          return 'screenshot.png';
        })
      ).map(userBrowser.guard),
    ];
    const run = {
      cwd,
      screenshots,
      tools,
      // The answer of a tool, as text.
      call: async (tool: string, args: Record<string, unknown> = {}) => {
        const found = tools.find(candidate => candidate.name === tool);

        assert.ok(found, `the tool ${tool} exists`);

        const answer = await withTimeout(Promise.resolve(found.handler(args as never)), 60_000, tool);

        return typeof answer === 'string' ? answer : JSON.stringify(answer);
      },
      close: async () => {
        await playwright.close().catch(() => {});
        await userBrowser.dispose();
      },
    };

    runs.push(run);

    return run;
  };

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

    // An agent's run: nothing is opened until it reaches for the browser.
    type Tab = { id: number; title: string; url: string; windowId: number; groupId: number; active: boolean; owned: boolean };
    const tabsNow = async () => (await hub.browser(BROWSER_ID)!.listTabs()) as Tab[];
    const first = await startRun('first');

    assert.match(await first.call('user_browsers_list'), /"name":"Check browser","connected":true,"lastSeenAt":null,"session":false/);
    assert.match(await first.call('user_browser_tabs'), /"title":"Stand page"/);
    assert.equal((await tabsNow()).some(tab => tab.owned), false);
    step('a run lists the browsers and the tabs of the user; no session is open yet');

    assert.match(await first.call('browser_navigate', { url: `${standOrigin}/agent.html` }), /Agent page/);

    const firstTab = (await tabsNow()).find(tab => tab.owned);
    const userWindow = (await tabsNow()).find(tab => tab.url.startsWith(CONSOLE_ORIGIN))!.windowId;

    assert.ok(firstTab, 'the session has a tab of its own');
    assert.deepEqual([firstTab.windowId, firstTab.active], [userWindow, false], "the session's tab is in the background of the user's window");
    await until("the session's tab is in its group", async () => (await tabsNow()).find(tab => tab.id === firstTab.id)?.groupId !== -1);
    assert.match(await first.call('user_browsers_list'), /"session":true/);
    step('the first browser call opened the session: a background tab in its own group, navigated');

    const snapshot = await first.call('browser_snapshot');
    const ref = /button "Press me" \[ref=([^\]]+)\]/.exec(snapshot)?.[1];

    assert.ok(ref, `the snapshot names the button: ${snapshot}`);
    await first.call('browser_click', { element: 'Press me button', target: ref });
    assert.match(await first.call('browser_evaluate', { function: '() => document.title' }), /Pressed/);
    await first.call('browser_take_screenshot');
    assert.ok(first.screenshots[0]?.length > 1000, 'a screenshot came back');
    step(`snapshot, click, evaluation and a screenshot (${first.screenshots[0].length} bytes) work through the session`);

    // A file of the workbench reaches the page of a browser that is, to
    // Playwright, on another machine.
    await writeFile(path.join(first.cwd, 'note.txt'), 'kept in the workbench');
    await first.call('browser_navigate', { url: `${standOrigin}/upload.html` });

    const uploadRef = /"Attachment" \[ref=([^\]]+)\]/.exec(await first.call('browser_snapshot'))?.[1];

    assert.ok(uploadRef, 'the snapshot names the file input');
    await first.call('browser_click', { element: 'Attachment', target: uploadRef });
    await first.call('browser_file_upload', { paths: [path.join(first.cwd, 'note.txt')] });
    await until('the page read the uploaded file', async () => /note\.txt: kept in the workbench/.test(await first.call('browser_evaluate', { function: '() => document.title' })));
    step('browser_file_upload hands a file of the workbench to the page');

    // A second run in the same browser, at the same time.
    const second = await startRun('second');

    assert.match(await second.call('browser_navigate', { url: `${standOrigin}/second.html` }), /Second agent page/);

    const owned = (await tabsNow()).filter(tab => tab.owned);
    const secondTab = owned.find(tab => tab.id !== firstTab.id);

    assert.equal(owned.length, 2, JSON.stringify(owned));
    await until('the second session has a group of its own', async () => {
      const groups = (await tabsNow()).filter(tab => tab.owned).map(tab => tab.groupId);

      return groups.every(group => group !== -1) && new Set(groups).size === 2;
    });
    assert.match(await first.call('browser_tabs', { action: 'list' }), /Upload page|note\.txt/);
    assert.doesNotMatch(await first.call('browser_tabs', { action: 'list' }), /Second agent page/);
    assert.match(await second.call('browser_evaluate', { function: '() => document.title' }), /Second agent page/);
    assert.match(await first.call('browser_evaluate', { function: '() => document.title' }), /note\.txt/);
    step('two runs hold sessions at once: each has its tab in its own group and sees only its own');

    // A session whose agent waits for its operator says nothing.
    if (SILENCE_SECONDS > 0) {
      await new Promise(resolve => setTimeout(resolve, SILENCE_SECONDS * 1000));
      assert.match(await first.call('browser_evaluate', { function: '() => document.title' }), /note\.txt/);
      assert.match(await second.call('browser_snapshot'), /Second agent page/);
      step(`both sessions work after ${SILENCE_SECONDS} s of silence`);
    }

    // The user says stop: the pause ends the sessions and drops the link.
    await optionsPage.locator('#paused').check();
    await until('the paused extension leaves the link', () => !hub.browser(BROWSER_ID));
    await assert.rejects(first.call('browser_snapshot'), /The user stopped the session in their browser "Check browser" of Check user/);
    await assert.rejects(second.call('browser_navigate', { url: `${standOrigin}/agent.html` }), /The user stopped the session/);
    await second.close();
    step('the pause ended both sessions: their tools answer that the user stopped the session');
    assert.equal((await ask<PageStatus>({ type: 'status' })).state, 'paused');
    await optionsPage.locator('#paused').uncheck();
    await until('the extension comes back after the pause', () => Boolean(hub.browser(BROWSER_ID)));
    step('the pause drops the link, its end brings the browser back with its secret');

    const left = (await tabsNow()).filter(tab => tab.id === firstTab.id || tab.id === secondTab?.id);

    assert.deepEqual(left.map(tab => tab.owned), [false, false], JSON.stringify(left));
    await assert.rejects(first.call('browser_snapshot'), /The user stopped the session/);
    assert.match(await first.call('user_browser_connect'), /A session is open in the browser "Check browser" of Check user/);
    assert.match(await first.call('browser_navigate', { url: `${standOrigin}/agent.html` }), /Agent page/);
    step('the tabs of the stopped sessions stay open and free; the run opens a new session only by user_browser_connect');

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

    // The links were dropped under the session of the run.
    await assert.rejects(first.call('browser_snapshot'), /The link to the browser "Check browser" of Check user was lost/);
    assert.match(await first.call('user_browser_connect'), /A session is open/);
    assert.match(await first.call('browser_navigate', { url: `${standOrigin}/agent.html` }), /Agent page/);
    step('a session whose link was lost says so, and the run connects again');

    // Revoked: the session ends, the browser forgets its secret and stays away.
    secret = '';
    hub.revoke(BROWSER_ID);
    await assert.rejects(first.call('browser_snapshot'), /Access to the browser "Check browser" of Check user was withdrawn/);
    step('a session of a revoked browser answers that access was withdrawn');
    await until('the revoked extension forgets its secret', async () => (await ask<PageStatus>({ type: 'status' })).state === 'unpaired');
    await new Promise(resolve => setTimeout(resolve, 3000));
    assert.equal(hub.browser(BROWSER_ID), null);
    assert.deepEqual(await ask<PageStatus>({ type: 'status' }), { version: manifest.version, state: 'unpaired', browserId: null });
    step('a revoked browser is unpaired and does not dial again');
  } finally {
    for (const run of runs) {
      await run.close().catch(() => {});
    }

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
