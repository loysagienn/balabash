// Designer agent: the design specialist. A Claude session with the full
// native tool preset on the per-user workbench, the Claude Design MCP server
// (claude.ai/design) as the medium of the craft — projects of HTML
// prototypes, mockups and decks the user opens, edits and comments on in the
// Claude Design editor — and its own headless Chromium (Playwright MCP,
// in-process) to SEE what it made: the verify loop of the Claude Design
// prompt (render → screenshot → gate → fresh eyes → fix). The fresh eyes are
// the design-verifier subagent the platform plugin ships
// (plugins/balabash/agents/design-verifier.md); it shares this session's
// browser tools. The craft itself is not retold here: the Claude Design
// prompt is fetched live (get_claude_design_prompt), this prompt only maps
// the session onto it.
//
// The browser is the declaration's `environment`: launched per run, torn down
// with the session. Ephemeral and headless — the pages it opens are
// Claude Design's render previews, no logins, no user intervention — so no
// persistent profile, no profile lock, no proxy, unlike the browser agent.
//
// Screenshots: the inner model must look at them, and bridge tools carry no
// bytes — so every screenshot is written to a known path in the run's
// disposable output directory (the model reads it with its native Read tool)
// and ingested into file storage (a fileId for send_file and the report).

import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import type { AgentDeclaration, RunContext, SessionEnvironment } from '../src/core/contract.ts';
import { workspaceFilesDir } from '../src/workspace/layout.ts';
import { connectPlaywrightMcp, createPlaywrightBridgeTools, imageExtension } from './kit/playwright.ts';
import type { PlaywrightImageSink, PlaywrightMcp } from './kit/playwright.ts';
import {
  BALABASH_PREAMBLE,
  CLAUDE_DESIGN_NOTE,
  PROJECTS_NOTE,
  TELEGRAM_OUTPUT_NOTE,
  WORKBENCH_NOTE,
  WORKSPACE_STORAGE_NOTE,
} from './world/index.ts';

const DESIGNER_MODEL = 'claude-opus-5-5';

// The verify loop's frame (the Claude Design prompt asks for 1440×900).
const VIEWPORT = { width: 1440, height: 900 };

const SYSTEM_PROMPT = `You are the design specialist of Balabash, talking to the user directly in a dedicated Telegram forum topic. ${BALABASH_PREAMBLE} Your craft is visual design delivered as Claude Design projects: landing pages, UI screens and prototypes, slide decks, design canvases with several options side by side — HTML the user opens, edits and comments on in the Claude Design editor (claude.ai/design).

${WORKBENCH_NOTE}

${WORKSPACE_STORAGE_NOTE}

${PROJECTS_NOTE}

${CLAUDE_DESIGN_NOTE}

The craft — how to design well and how the Claude Design tools are meant to be used — is the Claude Design prompt: call get_claude_design_prompt at the start of every task (with the bound design system when there is one) and follow it, plus read_design_skill when it points there. It is the live authority; this session maps onto it as follows:
- Browser tooling: you have your own headless Chromium through the browser_* tools (browser_navigate, browser_resize, browser_take_screenshot, browser_console_messages, browser_network_requests, browser_evaluate, browser_tabs, …) — these are the mcp__playwright__* tools the prompt talks about. The viewport is ${VIEWPORT.width}×${VIEWPORT.height} by default. Never call browser_close during a task — it closes the browser context; to see a fresh render just browser_navigate to the new serve_url.
- Screenshots: browser_take_screenshot returns no pixels. It saves the image to a file and reports the file's absolute path plus a stored fileId. Read the file with your native Read tool and actually LOOK at it before judging anything — never claim how something looks without having looked.
- Fresh eyes: the design-verifier subagent exists. Hand off to it with the Agent tool (subagent_type balabash:design-verifier) exactly as the prompt describes — a fresh serve_url, the project_id and path, the user's request verbatim. It uses the same browser tools and reads screenshots the same way.
- The verify loop runs after every write_files that touches a renderable deliverable. Do not skip it.
- Live preview for the user: you cannot open a browser on their machine — share the project URL with ?embed=1 appended and let them open it.
- Deliverable: the claude.ai/design link that opens the deliverable itself, plus the final screenshot sent into the topic with send_file (the fileId came with the screenshot). Never put a serve_url in user-visible text.
- Aesthetic direction: design systems come from list_design_systems; when none applies and the project is new, ask the user in this topic before designing, as the prompt says — a stated assumption only when they cannot answer.

Working cycle:
1. Understand the task; ask clarifying questions in the topic. Source materials arrive as fileIds — import them onto the workbench when their contents matter.
2. Load the prompt (and the design system), orient (list_projects / get_project / list_files), create or open the project, offer the live preview.
3. finalize_plan → create_support_js / copy_files → write_files with etags; verify loop; iterate.
4. Deliver: the link and the screenshot; iterate on the user's feedback in the topic and on comments queued from the editor (list_comments).
5. When the user is satisfied (or asks to stop), end the thread; your report states the project URL(s), what was produced and carries the fileIds of the final screenshots.

${TELEGRAM_OUTPUT_NOTE}

Stay with the assigned task. If the user clearly switches to an unrelated task or asks for the secretary, wrap up and end the thread.`;

function createScreenshotSink(ctx: RunContext, outputDir: string): PlaywrightImageSink {
  let count = 0;

  return async ({ data, mimeType }) => {
    count += 1;

    const filename = `screenshot-${String(count).padStart(2, '0')}-${new Date()
      .toISOString()
      .replace(/[:.]/g, '-')}.${imageExtension(mimeType)}`;
    const filePath = path.join(outputDir, filename);

    await writeFile(filePath, data);

    const stored = await ctx.files.ingest({ body: data, filename, contentType: mimeType, sizeBytes: data.length });

    return `[screenshot saved: ${filePath} — look at it with Read; stored as fileId=${stored.id}]`;
  };
}

async function createEnvironment(ctx: RunContext): Promise<SessionEnvironment> {
  // Disposable: screenshots are ingested at capture time; the local files,
  // snapshots and console logs go with the run.
  const outputDir = path.join(ctx.stateDir, 'runs', ctx.threadId);

  await mkdir(outputDir, { recursive: true });

  const browser = await chromium.launch({ executablePath: chromium.executablePath(), headless: true });
  let playwright: PlaywrightMcp | null = null;

  const dispose = async () => {
    await playwright?.close().catch(() => {});
    await browser.close().catch(() => {});
    await rm(outputDir, { recursive: true, force: true }).catch(() => {});
  };

  try {
    playwright = await connectPlaywrightMcp({
      outputDir,
      clientName: 'balabash-designer',
      // A fresh context per request: the server asks once per backend, and
      // a closed context is never handed back.
      context: () => browser.newContext({ viewport: VIEWPORT }),
    });

    const extraTools = await createPlaywrightBridgeTools(playwright.client, createScreenshotSink(ctx, outputDir));

    return { extraTools, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}

export const agent = {
  name: 'designer',
  description:
    'Start a design-specialist thread that works in Claude Design (claude.ai/design): landing pages, UI ' +
    'screens and prototypes, slide decks, several design options side by side — as projects the user opens, ' +
    'edits and comments on in the Claude Design editor. It works in its own topic, verifies its renders in ' +
    'its own browser, sends screenshots and iterates with the user directly. Spawn it for any visual design ' +
    'task; pass the task, all known content/context, the aesthetic direction if known, and the fileIds of ' +
    'any reference materials.',
  icon: '🎨',
  sdk: 'claude',
  tools: [
    'current_datetime',
    'events',
    'gmail',
    'http_get',
    'notion',
    'perplexity',
    'projects',
    'schedule',
    'storage',
    'storage_download_file',
    'workspace',
  ],
  notification: 'normal',

  session: {
    instructions: SYSTEM_PROMPT,
    model: DESIGNER_MODEL,
    preset: 'full',
    cwd: (userId: string) => workspaceFilesDir(userId),
    nativeServers: ['claude_design'],
    environment: (ctx: RunContext) => createEnvironment(ctx),
  },
} satisfies AgentDeclaration;
