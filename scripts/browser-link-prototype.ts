// The stand of the browser-link prototype: the hub on a loopback port of
// its own, outside the app, for the check with a real browser on a user's
// machine. The reverse proxy sends /browser-link/* of the console domain
// here; everything under /admin is reachable from this host only (the proxy
// does not route it) and asks for the same token.
//
//   BROWSER_LINK_TOKEN=<token> node scripts/browser-link-prototype.ts [port]
//
// The admin surface drives one session the way the browser agent would —
// through the kit's tools (agents/kit/playwright.ts):
//
//   GET  /admin/browsers          who is connected
//   GET  /admin/tabs              the tabs of the connected browser
//   POST /admin/session/open      opens a session, lists the tools
//   POST /admin/tool              { name, args } — one tool call
//   POST /admin/claim             { tabId } — hands a tab to the session
//   POST /admin/session/close
//
// Screenshots land in the directory named by BROWSER_LINK_OUTPUT (the
// system's temporary directory by default); the tool's answer is the path.

import { timingSafeEqual } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import type { Browser } from 'playwright';
import { connectPlaywrightMcp, createPlaywrightTools } from '../agents/kit/playwright.ts';
import type { PlaywrightMcp } from '../agents/kit/playwright.ts';
import type { SessionEnvironmentTool } from '../src/core/contract.ts';
import { createBrowserLinkHub } from '../src/browser-link/hub.ts';
import type { ExtensionSession } from '../src/browser-link/hub.ts';
import { startCdpRelay } from '../src/browser-link/relay.ts';
import type { CdpRelay } from '../src/browser-link/relay.ts';

const token = process.env.BROWSER_LINK_TOKEN ?? '';
const port = Number(process.argv[2] ?? 3041);
const outputDir = process.env.BROWSER_LINK_OUTPUT ?? path.join(os.tmpdir(), 'browser-link-prototype');

if (token.length < 24) {
  console.error('BROWSER_LINK_TOKEN must be set to a long random value');
  process.exit(1);
}

const sameToken = (candidate: string) => {
  const a = Buffer.from(candidate);
  const b = Buffer.from(token);

  return a.length === b.length && timingSafeEqual(a, b);
};

const log = (text: string) => console.log(`${new Date().toISOString()} ${text}`);

const hub = createBrowserLinkHub({ authenticate: async candidate => (sameToken(candidate) ? { id: 'prototype-browser' } : null) });

hub.onConnected = browser => log(`connected: "${browser.name}", extension ${browser.extensionVersion}`);
hub.onDisconnected = (browser, reason) => log(`disconnected: "${browser.name}" — ${reason}`);
hub.onReport = (browser, text) => log(`report from "${browser.name}": ${text}`);

type Active = {
  session: ExtensionSession;
  relay: CdpRelay;
  remote: Browser;
  playwright: PlaywrightMcp;
  tools: SessionEnvironmentTool[];
};

let active: Active | null = null;
// Why the last session ended, when it was the browser's side that ended it.
let lastEnd = '';
let screenshotCount = 0;

const theBrowser = () => {
  const [browser] = hub.browsers();

  if (!browser) {
    throw new Error('No browser is connected');
  }

  return browser;
};

async function closeSession(): Promise<void> {
  const current = active;

  active = null;

  if (!current) {
    return;
  }

  await current.playwright.close().catch(() => {});
  await current.remote.close().catch(() => {});
  await current.relay.close().catch(() => {});
}

async function openSession(): Promise<string[]> {
  await closeSession();
  await mkdir(outputDir, { recursive: true });

  const session = await theBrowser().openSession({ clientName: 'prototype' });
  const relay = await startCdpRelay(session);
  const toModel = session.onEvent;

  // What the extension tells about tabs and the debugger, without the CDP traffic.
  session.onEvent = (method, params) => {
    if (method !== 'chrome.debugger.onEvent') {
      const [first, second] = params as [{ id?: number; tabId?: number; url?: string; pendingUrl?: string } | number, unknown];
      const tab = typeof first === 'number' ? first : (first?.tabId ?? first?.id);
      const url = typeof first === 'object' ? (first?.url || first?.pendingUrl || '') : '';

      log(`session event ${method}: tab ${tab}${url ? ` ${url.slice(0, 60)}` : ''}${typeof second === 'string' ? ` — ${second}` : ''}`);
    }

    toModel?.(method, params);
  };

  const toRelay = session.onClose;

  session.onClose = reason => {
    lastEnd = reason;
    log(`the session link closed: ${reason}`);
    toRelay?.(reason);
  };
  lastEnd = '';

  const remote = await chromium.connectOverCDP(relay.endpoint, { noDefaults: true });
  const context = remote.contexts()[0];

  if (!context) {
    throw new Error('The browser gave no context');
  }

  const playwright = await connectPlaywrightMcp({
    outputDir: path.join(outputDir, 'mcp'),
    clientName: 'browser-link-prototype',
    cwd: outputDir,
    context: async () => context,
  });
  const tools = await createPlaywrightTools(playwright.client, async image => {
    const file = path.join(outputDir, `screenshot-${++screenshotCount}.${/jpe?g/i.test(image.mimeType) ? 'jpg' : 'png'}`);

    await writeFile(file, image.data);

    return file;
  });

  active = { session, relay, remote, playwright, tools };
  remote.on('disconnected', () => {
    if (active?.remote === remote) {
      log('the session ended on the browser side');
      void closeSession();
    }
  });

  return tools.map(tool => tool.name);
}

async function admin(route: string, body: Record<string, unknown>): Promise<unknown> {
  switch (route) {
    case 'GET /admin/browsers':
      return hub.browsers().map(browser => ({ name: browser.name, extensionVersion: browser.extensionVersion }));
    case 'GET /admin/tabs':
      return await theBrowser().listTabs();
    case 'POST /admin/session/open':
      return { tools: await openSession() };
    case 'POST /admin/session/close':
      await closeSession();

      return {};
    case 'POST /admin/claim': {
      if (!active) {
        throw new Error('No session is open');
      }

      await theBrowser().claimTab(active.session, Number(body.tabId));

      return {};
    }

    case 'POST /admin/tool': {
      const tool = active?.tools.find(candidate => candidate.name === body.name);

      if (!tool) {
        throw new Error(active ? `No tool ${String(body.name)}` : `No session is open${lastEnd ? ` — the last one ended: ${lastEnd}` : ''}`);
      }

      return { text: await tool.handler((body.args ?? {}) as never) };
    }
  }

  throw new Error(`No route ${route}`);
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://x');
  const chunks: Buffer[] = [];
  const reply = (status: number, value: unknown) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(value, null, 2));
  };

  if (!url.pathname.startsWith('/admin/') || !sameToken(String(request.headers['x-browser-link-token'] ?? ''))) {
    reply(404, { error: 'Not found' });

    return;
  }

  request.on('data', chunk => chunks.push(chunk as Buffer));
  request.on('end', () => {
    const text = Buffer.concat(chunks).toString();

    Promise.resolve()
      .then(() => admin(`${request.method} ${url.pathname}`, text ? (JSON.parse(text) as Record<string, unknown>) : {}))
      .then(
        value => reply(200, value),
        (error: unknown) => reply(500, { error: error instanceof Error ? error.message : String(error) }),
      );
  });
});

server.on('upgrade', (request, socket, head) => {
  if (!hub.handleUpgrade(request, socket, head)) {
    socket.destroy();
  }
});

server.listen(port, '127.0.0.1', () => log(`listening on 127.0.0.1:${port}; screenshots in ${outputDir}`));

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void closeSession().finally(() => {
      hub.close();
      server.close();
      process.exit(0);
    });
  });
}
