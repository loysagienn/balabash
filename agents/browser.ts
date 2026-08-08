// Browser agent: a real Chromium session driven by an inner Claude model
// through Playwright MCP. Port of the v1 agent onto the v2 thread model.
//
// The agent is a sub-agent for OTHER agents: its operator is the parent
// thread (the coordinator or any agent that spawned it), never the user —
// it knows nothing about the user. The thread is headless (§11.2): no forum
// topic. The dialogue is symmetric thread.message events: the operator sends
// instructions (sendToChild / send_to_thread), the browser executes and
// replies with its turn's final text (sendToParent). All the Playwright
// machinery stays in this thread, out of the operator's context; screenshots
// are ingested into workspace files at capture time and referenced by fileId.
//
// The Chromium profile is persistent per user (ctx.stateDir/profile): cookies
// and sessions survive between runs. Chromium cannot share one user data dir
// between processes, so concurrent runs of the same user queue on an
// in-process FIFO lock. With DISPLAY set the browser runs headful on the
// host's Xvfb display — the user can watch and intervene (login, CAPTCHA)
// through noVNC; without DISPLAY it falls back to headless.

import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import type { BrowserContext } from 'playwright';
import { createConnection } from '@playwright/mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type {
  AgentDeclaration,
  AgentRun,
  AgentSdkSession,
  ContentBlock,
  Event,
  JsonObject,
  RunContext,
  SdkBridgeTool,
} from '../src/core/contract.ts';

const NOVNC_URL = 'https://novnc.loysagienn.com/vnc.html';

const PLAYWRIGHT_CALL_TIMEOUT_MS = 5 * 60_000;

type BrowserInput = {
  task: string;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseInput(input: unknown): BrowserInput {
  if (!isObject(input) || typeof input.task !== 'string' || !input.task.trim()) {
    throw new Error('browser requires a non-empty task');
  }

  return { task: input.task.trim() };
}

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

  profileLockTails.set(
    key,
    previousTail.then(() => tail),
  );

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

  return () => {
    release();

    if (profileLockTails.get(key) === tail) {
      profileLockTails.delete(key);
    }
  };
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
    '- Take a screenshot only when the operator asks for one. The tool result reports a stored fileId — include that exact fileId in your reply so the operator can use the file.',
    `- Call finish only when the operator explicitly instructs you to finish/close the session: first browser_close, then finish with a concise result of the whole session. Never call finish on your own initiative.`,
  ].join('\n');
}

function buildInitialMessage(input: BrowserInput): string {
  return `Task: ${input.task}`;
}

function describeEvent(event: Event): string {
  return `[Balabash event]\ntype: ${event.type}\npayload: ${JSON.stringify(event.payload)}`;
}

// ---------------------------------------------------------------------------
// Playwright MCP → bridge tools: the inner session sees the browser tools as
// bridge-only tools; results are converted to canonical blocks, and images
// (screenshots) are ingested into workspace files at capture time.

function extensionOf(mimeType: string): string {
  if (mimeType.includes('jpeg') || mimeType.includes('jpg')) {
    return 'jpg';
  }

  return 'png';
}

async function convertPlaywrightResult(
  raw: Record<string, unknown>,
  ctx: RunContext,
): Promise<ContentBlock[]> {
  const content = Array.isArray(raw.content) ? raw.content : [];
  const blocks: ContentBlock[] = [];

  for (const item of content) {
    if (!isObject(item)) {
      continue;
    }

    if (item.type === 'text' && typeof item.text === 'string') {
      blocks.push({ type: 'text', text: item.text });
      continue;
    }

    if (item.type === 'image' && typeof item.data === 'string') {
      const mimeType = typeof item.mimeType === 'string' && item.mimeType ? item.mimeType : 'image/png';
      const body = Buffer.from(item.data, 'base64');
      const stored = await ctx.files.ingest({
        body,
        filename: `screenshot-${new Date().toISOString().replace(/[:.]/g, '-')}.${extensionOf(mimeType)}`,
        contentType: mimeType,
        sizeBytes: body.length,
      });

      blocks.push({ type: 'text', text: `[image stored as fileId=${stored.fileId}]` });
      blocks.push({ type: 'image', fileId: stored.fileId });
    }
  }

  if (raw.isError) {
    const text = blocks
      .map(block => (block.type === 'text' ? block.text : ''))
      .filter(Boolean)
      .join('\n');

    throw new Error(text || 'Browser tool call failed');
  }

  return blocks.length ? blocks : [{ type: 'text', text: '(empty result)' }];
}

// browser_take_screenshot only includes the image in its result when no
// `filename` is passed — and the image in the result is what gets ingested
// into workspace files (the local outputDir is disposable). Hide the
// parameter from the model entirely so every screenshot yields a fileId.
function sanitizeToolSchema(toolName: string, schema: Record<string, unknown>): Record<string, unknown> {
  if (toolName !== 'browser_take_screenshot' || !isObject(schema.properties)) {
    return schema;
  }

  const { filename: _dropped, ...properties } = schema.properties;
  const required = Array.isArray(schema.required) ? schema.required.filter(name => name !== 'filename') : undefined;

  return { ...schema, properties, ...(required ? { required } : {}) };
}

async function createPlaywrightBridgeTools(
  playwrightClient: Client,
  ctx: RunContext,
): Promise<SdkBridgeTool[]> {
  const { tools } = await playwrightClient.listTools();

  return tools.map(tool => ({
    name: tool.name,
    description: tool.description ?? tool.name,
    inputSchema: sanitizeToolSchema(
      tool.name,
      (tool.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
    ),
    handler: async (args: JsonObject) => {
      if (tool.name === 'browser_take_screenshot') {
        delete args.filename;
      }

      const raw = (await playwrightClient.callTool({ name: tool.name, arguments: args }, undefined, {
        timeout: PLAYWRIGHT_CALL_TIMEOUT_MS,
        resetTimeoutOnProgress: true,
      })) as Record<string, unknown>;

      return convertPlaywrightResult(raw, ctx);
    },
  }));
}

// ---------------------------------------------------------------------------

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
  headless: true,
  parameters: {
    type: 'object',
    properties: {
      task: {
        type: 'string',
        description:
          'The concrete browsing task to perform, in full detail — including where to start and any constraints (what not to do, limits, credentials policy).',
      },
    },
    required: ['task'],
    additionalProperties: false,
  },
  tools: [],
  notification: 'normal',

  run(rawInput: unknown, ctx: RunContext): AgentRun {
    const input = parseInput(rawInput);

    let settled = false;
    let endSummary: { text: string; fileIds?: string[] } | null = null;
    let resolveFinished: () => void;
    let rejectFinished: (error: unknown) => void;

    const finished = new Promise<void>((resolve, reject) => {
      resolveFinished = resolve;
      rejectFinished = reject;
    });

    const finishTool: SdkBridgeTool = {
      name: 'finish',
      description:
        'End the browser session and report the final result to the operator. Call ONLY when the operator explicitly instructed you to finish, after browser_close succeeded.',
      inputSchema: {
        type: 'object',
        properties: {
          result: { type: 'string', description: 'Concise final result of the whole session.' },
          screenshot_file_ids: {
            type: ['array', 'null'],
            items: { type: 'string' },
            description: 'fileIds of screenshots taken during the session, or null.',
          },
        },
        required: ['result', 'screenshot_file_ids'],
        additionalProperties: false,
      },
      handler: async (args: JsonObject) => {
        const result = typeof args.result === 'string' ? args.result.trim() : '';

        if (!result) {
          throw new Error('finish requires a non-empty result');
        }

        const fileIds = Array.isArray(args.screenshot_file_ids)
          ? args.screenshot_file_ids.filter((id): id is string => typeof id === 'string' && Boolean(id.trim()))
          : [];

        endSummary = { text: result, ...(fileIds.length ? { fileIds } : {}) };

        return 'accepted — finish this turn with a short handoff';
      },
    };

    type Cleanup = {
      session: AgentSdkSession | null;
      playwrightConnection: { close(): Promise<void> } | null;
      browserContext: BrowserContext | null;
      outputDir: string | null;
      releaseProfile: (() => void) | null;
    };

    const cleanup: Cleanup = {
      session: null,
      playwrightConnection: null,
      browserContext: null,
      outputDir: null,
      releaseProfile: null,
    };

    // Events routed while the browser is still starting are buffered and
    // flushed into the session once it exists.
    const preSessionInbox: string[] = [];

    const stop = (error?: unknown) => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup.session?.close();

      if (error === undefined) {
        resolveFinished();
      } else {
        rejectFinished(error);
      }
    };

    ctx.signal.addEventListener('abort', () => stop(), { once: true });

    void (async () => {
      try {
        cleanup.releaseProfile = await acquireProfileLock(ctx.stateDir, ctx.signal);

        const profileDir = path.join(ctx.stateDir, 'profile');
        const outputDir = path.join(ctx.stateDir, 'runs', ctx.threadId);

        cleanup.outputDir = outputDir;
        await mkdir(profileDir, { recursive: true });
        await mkdir(outputDir, { recursive: true });

        if (ctx.signal.aborted) {
          return;
        }

        const browserContext = await chromium.launchPersistentContext(profileDir, {
          executablePath: chromium.executablePath(),
          // Headful on the host's Xvfb display when available — the user can
          // watch and intervene through noVNC; headless otherwise.
          headless: !process.env.DISPLAY,
          args: ['--disable-blink-features=AutomationControlled'],
        });

        cleanup.browserContext = browserContext;

        const playwrightConnection = await createConnection({ outputDir, imageResponses: 'allow' }, async () => browserContext);

        cleanup.playwrightConnection = playwrightConnection;

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        const playwrightClient = new Client({ name: 'balabash-browser', version: '2.0.0' });

        await playwrightConnection.connect(serverTransport);
        await playwrightClient.connect(clientTransport);

        const playwrightTools = await createPlaywrightBridgeTools(playwrightClient, ctx);

        if (ctx.signal.aborted) {
          return;
        }

        const session = ctx.harness.sdkSession({
          instructions: `${SYSTEM_PROMPT}\n\n${buildInstructions()}`,
          initialMessage: buildInitialMessage(input),
          model: 'claude-opus-5',
          extraTools: [...playwrightTools, finishTool],
        });

        cleanup.session = session;

        for (const text of preSessionInbox.splice(0)) {
          session.push(text);
        }

        for await (const turn of session.turns) {
          if (settled) {
            return;
          }

          if (endSummary !== null) {
            await ctx.complete(endSummary);
            stop();

            return;
          }

          if (turn.text) {
            // The turn's final text IS the reply to the operator: an
            // addressed thread.message, which also journals the dialogue in
            // this thread's transcript.
            await ctx.sendToParent(turn.text);
          }
        }

        stop(settled ? undefined : new Error('Browser session ended before finish was called'));
      } catch (error) {
        stop(error);
      } finally {
        await cleanup.playwrightConnection?.close().catch(() => {});

        const browser = cleanup.browserContext?.browser();

        try {
          if (browser?.isConnected()) {
            await browser.close();
          } else {
            await cleanup.browserContext?.close();
          }
        } catch {
          // The browser process may already be gone.
        }

        if (cleanup.outputDir) {
          // Screenshots are ingested into files at capture time; the local
          // artifacts (snapshots, console logs) are disposable.
          await rm(cleanup.outputDir, { recursive: true, force: true }).catch(() => {});
        }

        cleanup.releaseProfile?.();
      }
    })();

    const sessionPush = (text: string): void => {
      if (!cleanup.session) {
        preSessionInbox.push(text);

        return;
      }

      try {
        cleanup.session.push(text);
      } catch {
        // The session may be closing; the run terminal covers the outcome.
      }
    };

    return {
      accept: (event: Event) => {
        if (settled) {
          return;
        }

        const payload = isObject(event.payload) ? event.payload : {};

        if (event.type === 'thread.message') {
          const text = typeof payload.text === 'string' ? payload.text.trim() : '';
          const fileIds = Array.isArray(payload.fileIds)
            ? payload.fileIds.filter((id): id is string => typeof id === 'string' && Boolean(id))
            : [];
          const parts = [
            ...(text ? [text] : []),
            ...fileIds.map(fileId => `[the operator attached a file: fileId=${fileId}]`),
          ];

          if (parts.length) {
            sessionPush(parts.join('\n'));
          }

          return;
        }

        sessionPush(describeEvent(event));
      },
      finished,
    };
  },
} satisfies AgentDeclaration;
