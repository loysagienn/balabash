// End-to-end check of the browser link on this host, without a user's
// machine: a Chromium with the built extension plays the user's browser,
// the hub and the relay run in this process, and the agent's own browser
// tools (agents/kit/playwright.ts) drive it through connectOverCDP.
//
//   node build/browser-extension.js && node scripts/browser-link-check.ts
//
// It answers one question: does the chain extension → link → relay →
// Playwright → the kit's tools work. It touches neither the app nor its
// database. Each step prints a line; the first failure ends the run with a
// non-zero exit code.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { connectPlaywrightMcp, createPlaywrightTools } from '../agents/kit/playwright.ts';
import { createBrowserLinkHub } from '../src/browser-link/hub.ts';
import type { ConnectedBrowser } from '../src/browser-link/hub.ts';
import { startCdpRelay } from '../src/browser-link/relay.ts';

// The functions passed to the extension's worker run there, where `chrome` is.
declare const chrome: {
  storage: { local: { set(items: Record<string, unknown>): Promise<void> } };
  windows: { create(options: Record<string, unknown>): Promise<{ id?: number }> };
};

const EXTENSION_DIR = path.resolve('dist', 'browser-extension');
const TOKEN = randomUUID();

const PAGES: Record<string, string> = {
  '/user.html': '<title>User tab</title><h1>A page the user had open</h1><p id="secret">kept by the user</p>',
  '/agent.html':
    '<title>Agent page</title><h1>Agent page</h1><button onclick="document.title=\'Pressed\'">Press me</button>' +
    '<input aria-label="Note" />',
};

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
  const hub = createBrowserLinkHub({ authenticate: async token => (token === TOKEN ? { id: 'check-browser' } : null) });
  const server = http.createServer((request, response) => {
    const body = PAGES[new URL(request.url ?? '/', 'http://x').pathname];

    response.writeHead(body ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
    response.end(body ?? 'Not found');
  });

  server.on('upgrade', (request, socket, head) => {
    if (!hub.handleUpgrade(request, socket, head)) {
      socket.destroy();
    }
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));

  const port = (server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;
  const nextConnection = () =>
    new Promise<ConnectedBrowser>(resolve => {
      hub.onConnected = browser => resolve(browser);
    });

  // The user's browser: a profile with the extension and one tab of its own.
  const userBrowser = await chromium.launchPersistentContext(path.join(workDir, 'profile'), {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`],
  });

  try {
    const userPage = userBrowser.pages()[0] ?? (await userBrowser.newPage());

    await userPage.goto(`${origin}/user.html`);

    const worker = userBrowser.serviceWorkers()[0] ?? (await withTimeout(userBrowser.waitForEvent('serviceworker'), 15_000, 'the extension worker'));

    step(`the extension is loaded (${worker.url()})`);

    // A wrong token is refused.
    let connection = nextConnection();

    await worker.evaluate(settings => chrome.storage.local.set(settings), {
      serverUrl: `ws://127.0.0.1:${port}`,
      token: 'wrong',
      name: 'Check browser',
      paused: false,
    });
    await new Promise(resolve => setTimeout(resolve, 2000));
    assert.equal(hub.browsers().length, 0, 'a wrong token must not connect');
    step('a wrong token is refused');

    await worker.evaluate(token => chrome.storage.local.set({ token }), TOKEN);

    let browser = await withTimeout(connection, 15_000, 'the control link');

    assert.equal(browser.name, 'Check browser');
    step(`the extension dialed in by itself: "${browser.name}", extension ${browser.extensionVersion}`);

    // The list of tabs needs no debugger.
    const tabs = await browser.listTabs();
    const userTab = tabs.find(tab => tab.title === 'User tab');

    assert.ok(userTab, `the user's tab is in the list: ${JSON.stringify(tabs)}`);
    assert.equal(userTab.owned, false);
    step(`tabs are listed without a session: ${tabs.map(tab => JSON.stringify(tab.title || tab.url)).join(', ')}`);

    // The window the user looks at need not be one with tabs: the console
    // installed as an app is a window of its own, and it has no tab groups.
    await worker.evaluate(url => chrome.windows.create({ type: 'popup', focused: true, url }), `${origin}/user.html`);

    // A session: the link, the relay, Playwright over CDP.
    const session = await browser.openSession({ clientName: 'check' });
    const sessionTab = (await browser.listTabs()).find(tab => tab.owned);

    assert.ok(sessionTab, 'the session has a tab of its own');
    assert.equal(sessionTab.windowId, userTab.windowId, "the session's tab is in the window with tabs");
    assert.equal(sessionTab.active, false, "the session's tab stays in the background");
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.notEqual((await browser.listTabs()).find(tab => tab.id === sessionTab.id)?.groupId, -1, "the session's tab is in its group");
    step("the session's tab is in the background of the window with tabs, in its own group");

    const relay = await startCdpRelay(session);
    const remote = await withTimeout(chromium.connectOverCDP(relay.endpoint, { noDefaults: true }), 30_000, 'connectOverCDP');
    const context = remote.contexts()[0];

    assert.ok(context, 'the browser has its default context');
    assert.equal(context.pages().length, 1, 'the session starts with one blank tab');
    step('connectOverCDP reached the browser through the relay; the session has its own blank tab');

    // A tab the client opens joins the session's tab, in the background.
    const opened = await context.newPage();
    const openedTab = (await browser.listTabs()).find(tab => tab.owned && tab.id !== sessionTab.id);

    assert.ok(openedTab, 'the opened tab is the session\'s');
    assert.equal(openedTab.windowId, userTab.windowId, 'the opened tab is in the window with tabs');
    assert.equal(openedTab.active, false, 'the opened tab stays in the background');
    await opened.close();
    step('a tab the client opens lands in the same window, in the background');

    // The agent's tools, exactly as the browser agent builds them.
    const screenshots: Buffer[] = [];
    const playwright = await connectPlaywrightMcp({
      outputDir: path.join(workDir, 'output'),
      clientName: 'browser-link-check',
      cwd: workDir,
      context: async () => context,
    });
    const tools = await createPlaywrightTools(playwright.client, async image => {
      screenshots.push(image.data);

      return 'screenshot.png';
    });
    const call = (name: string, args: Record<string, unknown>) => {
      const tool = tools.find(candidate => candidate.name === name);

      assert.ok(tool, `the tool ${name} exists`);

      return withTimeout(Promise.resolve(tool.handler(args as never)).then(String), 60_000, name);
    };

    const navigated = await call('browser_navigate', { url: `${origin}/agent.html` });

    assert.match(navigated, /Agent page/);
    step('browser_navigate opened a page');

    const snapshot = await call('browser_snapshot', {});
    const ref = /button "Press me" \[ref=([^\]]+)\]/.exec(snapshot)?.[1];

    assert.ok(ref, `the snapshot names the button: ${snapshot}`);
    step('browser_snapshot returned the accessibility tree');

    const clickSchema = tools.find(tool => tool.name === 'browser_click')!.inputSchema as { properties?: Record<string, unknown> };
    const refKey = clickSchema.properties && 'target' in clickSchema.properties ? 'target' : 'ref';

    await call('browser_click', { element: 'Press me button', [refKey]: ref });

    const title = await call('browser_evaluate', { function: '() => document.title' });

    assert.match(title, /Pressed/);
    step('browser_click and browser_evaluate acted on the page');

    await call('browser_take_screenshot', {});
    assert.ok(screenshots[0] && screenshots[0].length > 1000, 'a screenshot came back');
    step(`browser_take_screenshot returned ${screenshots[0].length} bytes`);

    // A tab of the user, handed to the session.
    const claimed = withTimeout(context.waitForEvent('page'), 15_000, 'the claimed tab');

    await browser.claimTab(session, userTab.id);

    const claimedPage = await claimed;

    assert.equal(await claimedPage.title(), 'User tab');
    assert.equal(await claimedPage.locator('#secret').textContent(), 'kept by the user');
    step("a tab of the user was handed to the session and read");

    const listed = await call('browser_tabs', { action: 'list' });

    assert.match(listed, /User tab/);
    assert.match(listed, /Pressed/);
    step('browser_tabs lists both tabs of the session');

    // What the extension refuses stays refused.
    await assert.rejects(context.addCookies([{ name: 'x', value: 'y', url: origin }]), /not allowed/);
    step('writing cookies is refused by the extension');

    const afterClaim = await browser.listTabs();

    assert.equal(afterClaim.find(tab => tab.id === userTab.id)?.owned, true);

    // The end of the session leaves the tabs open and free.
    await playwright.close();
    await remote.close();
    await relay.close();
    await new Promise(resolve => setTimeout(resolve, 500));

    const afterSession = await browser.listTabs();

    assert.equal(afterSession.find(tab => tab.id === userTab.id)?.owned, false, 'the tab is free again');
    assert.ok(afterSession.some(tab => tab.title === 'Pressed'), "the session's tab stays open");
    step('the session ended: its tabs stay open and are free again');

    // A dropped link comes back by itself.
    connection = nextConnection();
    browser.disconnect('check');
    browser = await withTimeout(connection, 15_000, 'the reconnect');
    assert.ok((await browser.listTabs()).length >= 2);
    step('a dropped control link was dialed again by the extension');

    console.log('\nPASS');
  } finally {
    hub.close();
    await userBrowser.close().catch(() => {});
    server.closeAllConnections();
    server.close();
    await rm(workDir, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(0),
  error => {
    console.error('\nFAIL', error);
    process.exit(1);
  },
);
