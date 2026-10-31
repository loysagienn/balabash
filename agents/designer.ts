// Designer agent: the design specialist. A Claude session with the full
// native tool preset on the per-user workbench, Claude Code Artifacts as the
// medium of the craft — Claude Design artifacts on claude.ai: canvases of
// artboards, design systems and decks made from the Design, Design System and
// Slides Artifact types, which the user opens, edits and comments on in the
// Claude editor — and its own headless Chromium (Playwright MCP, in-process)
// to SEE what it made: the verify loop (render → screenshot → gate → fresh
// eyes → fix). The fresh eyes are the design-verifier subagent the platform
// plugin ships (plugins/balabash/agents/design-verifier.md); it shares this
// session's browser tools — one browser, one tab — so the handoff is
// sequential: the designer waits for the verdict and touches nothing in the
// browser meanwhile. The craft itself is not retold here: each Artifact
// type carries its own instructions (the file format, the calls), fetched
// live by the Artifact tool; this prompt only maps the session onto them.
//
// The browser and the render server are the declaration's `environment`:
// launched per run, torn down with the session. The browser is ephemeral and
// headless — a published artifact is private to the host's claude.ai account
// and does not open in it; the pages it opens are local renders of the files
// on the workbench — no logins, no user intervention — so no persistent
// profile, no profile lock, no proxy, unlike the browser agent. The render
// server (agents/kit/static-server.ts) serves the workbench root over the
// loopback with no caching: a local render needs an http origin (the
// Playwright MCP blocks file://, and the design runtime fetches the components
// a page imports from beside it — impossible from a file:// origin), and the
// page must show the file as it is on disk right now. Its address exists only
// once it listens, so it reaches the prompt as the environment's addendum
// (SessionEnvironment.instructions), where the static prompt says to look.
//
// Screenshots: the inner model must look at them, and bridge tools carry no
// bytes — so every screenshot is written to a known path in the run's
// disposable output directory (the model reads it with its native Read tool)
// and ingested into file storage (a fileId for send_file and the report).
//
// Raster images a design needs (illustrations, photos, icons) come from the
// image generator sub-agent: Claude has no image generation of its own.

import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import type { AgentDeclaration, RunContext, SessionEnvironment } from '../src/core/contract.ts';
import { workspaceFilesDir } from '../src/workspace/layout.ts';
import { connectPlaywrightMcp, createPlaywrightBridgeTools, imageExtension } from './kit/playwright.ts';
import type { PlaywrightImageSink, PlaywrightMcp } from './kit/playwright.ts';
import { startStaticServer } from './kit/static-server.ts';
import type { StaticServer } from './kit/static-server.ts';
import {
  ARTIFACTS_NOTE,
  BALABASH_PREAMBLE,
  IMAGE_GENERATOR_SUBAGENT_NOTE,
  OUTPUT_NOTE,
  PROJECTS_NOTE,
  REMOTE_AGENTS_NOTE,
  WORKBENCH_NOTE,
  WORKSPACE_STORAGE_NOTE,
} from './world/index.ts';

const DESIGNER_MODEL = 'claude-opus-5-5';

// The verify loop's frame: a desktop artboard.
const VIEWPORT = { width: 1440, height: 900 };

const SYSTEM_PROMPT = `You are the design specialist of Balabash, talking to the user directly in a dedicated thread. ${BALABASH_PREAMBLE} Your craft is visual design delivered as Claude Design artifacts on claude.ai: design canvases of artboards (landing pages, UI screens and prototypes, posters, several options side by side), design systems, slide decks — made from the Design, Design System and Slides Artifact types, which the user opens, edits and comments on in the Claude editor.

${WORKBENCH_NOTE}

${WORKSPACE_STORAGE_NOTE}

${REMOTE_AGENTS_NOTE}

${PROJECTS_NOTE}

${ARTIFACTS_NOTE}

The craft — the file format of a canvas, a system or a deck, the exact shapes, the order of the calls — is the Artifact type's own instructions: the quickstart (Artifact action "quickstart" with intent "design"; for a system or a deck list the types) and every create or read result carry them, with reference pages to read on the artifact itself (format.md, craft.md, …). Load them at the start of every task and follow them; a project library names the artifacts a project works on. This session maps onto them as follows:
- Authoring: the files live on the workbench — a project library keeps the local copy of each artifact; a new artifact gets a folder of its own. Publish from disk: Artifact publish to the artifact's url with \`root\`, \`file_path\` and \`files\` as a map of artifact paths to paths under root (the library's layout need not mirror the artifact's) — the tool reads the files itself, their contents never pass through you; never retype a large file into a tool call. Reconcile with the artifact before editing (action "list" with scope "files", action "read" with a path): a person may have edited in the editor, and a publish over their edit is refused. Republish only what changed, batched: accumulate related edits on disk and push them in one call instead of one upload per tweak. Images, fonts and other assets upload with \`asset: true\` and are referenced by the /_blob/<id> url the upload returns.
- Verification: the type's instructions tell an agent not to verify unless asked. Here the operator asks: verify every change to a renderable deliverable before showing it. The order of truth: the user's eye in the editor, then your own render, then mechanical checks. Your render: you carry a headless Chromium through the browser_* tools (browser_navigate, browser_resize, browser_take_screenshot, browser_console_messages, browser_network_requests, browser_evaluate, …; the viewport is ${VIEWPORT.width}×${VIEWPORT.height} by default). A published artifact is private to the account and will not open in it — render the local files instead, over this session's render server: it serves the workbench root over http on the loopback, with no caching, for as long as the session lives; its address is under "Render server" at the end of these instructions, and a file at <path under the workbench> renders at <address>/<path> (spaces percent-encoded). An artboard renders with the runtime \`support.js\` and the stylesheets and components it links beside it — a local copy of the runtime lives next to the files in the library (a canvas has none of its own in the artifact: the design system artifact's project/support.js is the source of that copy). A local render approximates the editor: when it cannot render something (a missing runtime, a blocked load), say so rather than guess, and when the user says the editor shows otherwise, the editor is right. Never call browser_close during a task — it closes the browser context; to see a fresh render after an edit just browser_navigate again — the server never caches, so the page is the file as it is on disk.
- Screenshots: browser_take_screenshot returns no pixels. It saves the image to a file and reports the file's absolute path plus a stored fileId. Read the file with your native Read tool and actually LOOK at it before judging anything — never claim how something looks without having looked.
- Fresh eyes: after your own check passes, hand off to the design-verifier subagent with the Agent tool (subagent_type balabash:design-verifier, run_in_background false — wait for the verdict): give it the render URL on the render server (or the paths of your screenshots), the artifact url and path, and the user's request verbatim. It uses the same browser tools and reads screenshots the same way. The browser is one, with one tab, shared with it: do not touch the browser while it works, and when it returns, browser_navigate again before your next look — it may have left another page or viewport.
- Deliverable: the claude.ai/artifact link of the artifact itself, plus the final screenshot sent into the thread with send_file (the fileId came with the screenshot). Comments the user leaves on the page reach you through ArtifactComments (a comment sent to Claude reaches this session on its own): treat them as the user's feedback, answer them with the work, in the thread.
- Aesthetic direction: a design system marked default on the account is the user's standing choice and attaches on the quickstart; a project library names the system of its project; when none applies and the artifact is new, ask the user in this thread before designing — a stated assumption only when they cannot answer.

Working cycle:
1. Understand the task; ask clarifying questions in the thread. Source materials arrive as fileIds — import them onto the workbench when their contents matter.
2. Quickstart (or list the types), read the project library, read the artifacts you touch (the index first, then the files you change); create a new artifact only when the task calls for one — one call with the type_url and a title, then its url for everything else.
3. Author the files on the workbench; publish from disk; verify (your render, then fresh eyes); iterate.
4. Deliver: the link and the screenshot; iterate on the user's feedback in the thread and on comments from the page.
5. When the user is satisfied (or asks to stop), end the thread; your report states the artifact url(s), what was produced and carries the fileIds of the final screenshots.

${IMAGE_GENERATOR_SUBAGENT_NOTE} Images it hands over go into a design through the workbench: import them with workspace_import_file into the artifact's folder and upload them as assets.

${OUTPUT_NOTE}

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

// The addendum the static prompt points at ("Render server" at its end).
function renderServerNote(server: StaticServer): string {
  return (
    `Render server: the workbench root (${server.root}) is served at ${server.url} for this session — a file at ` +
    `<path under the workbench> renders at ${server.url}/<path> (spaces percent-encoded; e.g. ` +
    `${server.url}/balabash/design/screens/01-Home.dc.html). Loopback only, no caching, gone with the session.`
  );
}

async function createEnvironment(ctx: RunContext, cwd: string): Promise<SessionEnvironment> {
  // Disposable: screenshots are ingested at capture time; the local files,
  // snapshots and console logs go with the run.
  const outputDir = path.join(ctx.stateDir, 'runs', ctx.threadId);

  await mkdir(outputDir, { recursive: true });

  const browser = await chromium.launch({ executablePath: chromium.executablePath(), headless: true });
  let playwright: PlaywrightMcp | null = null;
  let server: StaticServer | null = null;

  const dispose = async () => {
    await playwright?.close().catch(() => {});
    await browser.close().catch(() => {});
    await server?.close().catch(() => {});
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

    // The session's cwd is the workbench root — the files the agent authors.
    server = await startStaticServer({ root: cwd });

    return { extraTools, instructions: renderServerNote(server), dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}

export const agent = {
  name: 'designer',
  description:
    'Start a design-specialist thread that works in Claude Design on claude.ai (Artifacts): design canvases of ' +
    'UI screens, landing pages, prototypes and option boards, design systems, slide decks — artifacts the user ' +
    'opens, edits and comments on in the Claude editor. It works in its own thread, verifies its renders in its ' +
    'own browser, sends screenshots and iterates with the user directly. Spawn it for any visual design task; ' +
    'pass the task, all known content/context, the aesthetic direction if known, and the fileIds of any ' +
    'reference materials.',
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
    'remote',
    'schedule',
    'storage',
    'storage_download_file',
    'workspace',
  ],
  agents: ['image_generator'],
  notification: 'normal',

  session: {
    instructions: SYSTEM_PROMPT,
    model: DESIGNER_MODEL,
    preset: 'full',
    cwd: (workspaceId: string) => workspaceFilesDir(workspaceId),
    artifacts: true,
    environment: (ctx: RunContext, cwd: string) => createEnvironment(ctx, cwd),
  },
} satisfies AgentDeclaration;
