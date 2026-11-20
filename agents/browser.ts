// Browser agent: a real Chromium session driven by an inner Claude model
// through Playwright MCP. Port of the legacy (pre-thread) agent onto the
// thread model.
//
// The agent is a sub-agent for OTHER agents: its operator is the parent
// thread (the coordinator or any agent that spawned it), never the user —
// it knows nothing about the user. The thread is headless: no user-facing
// surface. The dialogue is symmetric thread.message events: the operator sends
// instructions (send_to_thread), the browser executes and
// replies with its turn's final text. All the Playwright
// machinery stays in this thread, out of the operator's context; screenshots
// are temporary workbench files until the operator needs an exported copy.
//
// The Chromium profile is persistent per user (ctx.stateDir/profile): cookies
// and sessions survive between runs. The inner session itself is a full-preset
// session (native shell and file tools) with cwd in the user's workspace file
// area, like the other workbench agents; the profile and the disposable
// Playwright output stay in the run's stateDir. Chromium cannot share one user data dir
// between processes, so concurrent runs of the same user queue on an
// in-process FIFO lock. With DISPLAY set the browser runs headful on the
// host's Xvfb display — the user can watch and intervene (login, CAPTCHA)
// through noVNC; without DISPLAY it falls back to headless.
//
// Outbound traffic goes through the host's HTTP proxy named by
// BROWSER_PROXY_SERVER (Privoxy on 127.0.0.1:8118, which forwards `.ru`
// domains into the Moscow SOCKS tunnel and everything else directly). Unset,
// the browser connects directly.

import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import type { BrowserContext } from 'playwright';
import type { AgentDeclaration, RunContext, SessionEnvironment } from '../src/core/contract.ts';
import { connectPlaywrightMcp, createPlaywrightTools, sessionScreenshots } from './kit/playwright.ts';
import type { PlaywrightMcp } from './kit/playwright.ts';
import { workspaceFilesDir } from '../src/workspace/layout.ts';
import { BLOCKED_PATH_NOTE, BROWSER_RELAUNCHED_NOTE } from './world/index.ts';

const NOVNC_URL = 'https://novnc.loysagienn.com/vnc.html';

// Read once: the running app's environment, not per launch (see the header).
const proxyServer = process.env.BROWSER_PROXY_SERVER?.trim() || null;

// Chromium launch flags. The host has no GPU (Xvfb or headless), so WebGPU
// sites — Astronelia among them — get no adapter with the stock flags and
// refuse to render. The four GPU flags turn on WebGPU over software Vulkan
// (SwiftShader): the adapter appears in both headful and headless modes, at
// the cost of some CPU on WebGPU pages only. Ordinary pages are unaffected —
// no site is forced through the software path unless it asks for WebGPU.
const CHROMIUM_ARGS = [
  // Hide the navigator.webdriver automation marker.
  '--disable-blink-features=AutomationControlled',
  // WebGPU without a real GPU (see above).
  '--enable-unsafe-webgpu',
  '--enable-features=Vulkan',
  '--use-angle=swiftshader',
  '--ignore-gpu-blocklist',
];

// ---------------------------------------------------------------------------
// Profile lock: one Chromium per user data dir. In-process FIFO keyed by the
// run's stateDir; waiting is interruptible through the run's abort signal.

const profileLockTails = new Map<string, Promise<void>>();

async function acquireProfileLock(key: string, signal: AbortSignal): Promise<() => void> {
  const previousTail = profileLockTails.get(key) ?? Promise.resolve();

  let release!: () => void;
  const tail = new Promise<void>(resolve => {
    release = resolve;
  });

  const queued = previousTail.then(() => tail);
  profileLockTails.set(key, queued);
  void queued.then(() => {
    if (profileLockTails.get(key) === queued) profileLockTails.delete(key);
  });

  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      release(); // keep the queue moving for the next waiter
      reject(new Error('Browser run aborted while waiting for the profile'));
    };

    if (signal.aborted) {
      onAbort();
      return;
    }

    signal.addEventListener('abort', onAbort, { once: true });

    void previousTail.then(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    });
  });

  return release;
}

// ---------------------------------------------------------------------------
// Prompts

const SYSTEM_PROMPT = 'You are a focused browser automation sub-agent. Follow the operator protocol exactly.';

function buildInstructions(): string {
  return [
    'You are a browser operator working for another agent — your OPERATOR. You drive a real browser with the supplied browser tools; the operator drives you with instructions. You never talk to a human and know nothing about any end user.',
    '',
    'Protocol:',
    '- The first message carries the initial task; later instructions arrive as follow-up messages. Execute the current instruction with the browser tools, then reply.',
    '- The final text of each of your turns IS your reply to the operator. Make it a concise, factual report of the outcome and the current page state (what is visible, what actions are available). Never narrate low-level machinery: snapshots, selectors, click coordinates, retries, DOM details stay in this thread.',
    '- Completing an instruction NEVER ends the run: reply and wait for the next instruction, keeping the browser open. This is a multi-step collaboration, not request-response.',
    `- If a page requires login, CAPTCHA, 2FA, a passkey, or any other human verification: do NOT try to solve or bypass it yourself and do not ask for codes or passwords. Reply to the operator that manual intervention is required in the live browser at ${NOVNC_URL}, and continue only after the operator confirms the step is done.`,
    '- Take a screenshot only when the operator asks for one. The result is a workbench-relative path. Call export_file with that path and include the returned id in your reply. Attach the ids of the requested screenshots in end_thread.files when you finish.',
    '- When an instruction asks you to collect structured data from pages (listings, tables, many items), never dump it into your reply: extract it in batches (page evaluation returning limited chunks), store it into the workspace database — into the table the operator named, or a sensibly named new one — and reply with row counts plus a small sample. The workspace data tools are shared with the operator and other agents.',
    "- Your working directory is the operator's workspace file area — the workbench shared with the operator and other agents. Your native tools (shell, file reads and edits) work there: `./x` for them is the same file as `x` for the workspace bridge tools. Use them for what the browser tools cannot do well — post-processing extracted data, saving page content or downloads as files. The host beyond the workbench is not yours to explore.",
    '- End the session only when the operator explicitly instructs you to finish: close the browser, then call end_thread with the result of the whole session. Never finish on your own initiative.',
  ].join('\n');
}

function buildInitialMessage(prompt: string): string {
  return `Task: ${prompt}`;
}

// ---------------------------------------------------------------------------
async function createEnvironment(ctx: RunContext, cwd: string): Promise<SessionEnvironment> {
  const release = await acquireProfileLock(ctx.stateDir, ctx.signal);
  const profileDir = path.join(ctx.stateDir, 'profile');
  const outputDir = path.join(ctx.stateDir, 'runs', ctx.threadId);
  const screenshots = sessionScreenshots(cwd, ctx.threadId);
  let context: BrowserContext | undefined;
  let playwright: PlaywrightMcp | undefined;
  const dispose = async () => {
    await playwright?.close().catch(() => {});
    await context?.close().catch(() => {}); // Closing a persistent context also closes Chromium.
    await screenshots.dispose().catch(() => {});
    await rm(outputDir, { recursive: true, force: true }).catch(() => {});
    release();
  };

  try {
    await mkdir(profileDir, { recursive: true });
    await mkdir(outputDir, { recursive: true });
    ctx.signal.throwIfAborted();
    const browserContext = await chromium.launchPersistentContext(profileDir, {
      executablePath: chromium.executablePath(),
      headless: !process.env.DISPLAY,
      args: CHROMIUM_ARGS,
      ...(proxyServer ? { proxy: { server: proxyServer } } : {}),
    });
    context = browserContext;
    playwright = await connectPlaywrightMcp({
      outputDir, cwd, clientName: 'balabash-browser', context: async () => browserContext,
    });
    const environmentTools = await createPlaywrightTools(playwright.client, screenshots.save);
    return { environmentTools, ...(ctx.resume ? { instructions: BROWSER_RELAUNCHED_NOTE } : {}), dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}

export const agent = {
  name: 'browser',
  description:
    'A browser-operating sub-agent: it drives a real browser (navigation, forms, clicks, authentication flows) ' +
    'under your step-by-step instructions, keeping all the page machinery in its own thread. Do not use it for ' +
    'merely fetching a URL or downloading a file. The thread is headless — the sub-agent talks only to you: ' +
    'send instructions with send_to_thread, its replies arrive as thread.message events. It never ends on its ' +
    'own: it executes an instruction, reports back and waits for the next one — tell it explicitly to finish, ' +
    'or cancel the thread. If it reports that manual human intervention is needed (login, CAPTCHA), decide ' +
    'yourself or pass the request on.',
  sdk: 'claude',
  modes: ['headless'],
  defaultMode: 'headless',
  workspaceDisk: true,
  access: { nodes: ['workspace'], addRoot: ['get_file_url'] },
  notification: 'normal',

  session: {
    instructions: `${SYSTEM_PROMPT}\n\n${BLOCKED_PATH_NOTE}\n\n${buildInstructions()}`,
    initialMessage: buildInitialMessage,
    model: 'claude-opus-5-5',
    preset: 'full',
    cwd: workspaceFilesDir,
    environment: createEnvironment,
  },
} satisfies AgentDeclaration;
