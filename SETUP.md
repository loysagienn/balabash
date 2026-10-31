# Setting up and running Balabash

What an installation of Balabash consists of, what it needs and how it is
started. `README.md` says what the system is; `DEVELOPMENT.md` is the guide
for working on the code.

## The process

One Node.js process (`dist/app.js`), started from the repository root — every
runtime path (`data/`, `dist/`, `files/`) resolves from the cwd. Boot order:
`prisma migrate deploy` → database check → tombstone of orphaned threads →
agent catalog (repository agents, then `data/remote-agents`) → tool servers
(repository `tools/`, then `data/tools` and `data/mcp-servers`) → web server
→ channel adapters (Telegram and CCR when configured) → router, consumers,
schedule heart, indexer → restart module. The process listens on one
loopback port (`HTTP_PORT`); a TLS-terminating reverse proxy sends the whole
console host (and the apps host, if any) to it with `Host` and
`X-Forwarded-Proto` preserved.

Code changes go live only through a restart. In production the process runs
under `supervisor.js`, which reads exit codes alone: `42` — a restart was
requested and the safe window reached, relaunch at once; `0` — stop; anything
else — a crash, relaunch with backoff, and after three quick crashes roll
`dist/` back to the last bundle that stayed up for a minute, leaving a marker
the next boot reports into the log.

## What an installation needs

- **Node.js ≥ 24** (`node:sqlite` is the workbench database) and
  **PostgreSQL 16**; `npm install` (its `postinstall` patches the Claude
  Agent SDK bridge).
- **`.env`** from `.env.example`. Required: `DATABASE_URL`, `CONSOLE_DOMAIN`,
  `HTTP_PORT`, `SESSION_PEPPER`, and the secretary's backend — `OPENAI_API_KEY`
  + `MAIN_OPENAI_MODEL` (`LLM_BACKEND=openai`, the default, or
  `openai-compatible` with `OPENAI_BASE_URL`) or `MAIN_ANTHROPIC_API_KEY` +
  `MAIN_ANTHROPIC_MODEL` (`LLM_BACKEND=anthropic`). `OPENAI_API_KEY` is also
  the key of the workspace annotation indexer (`INDEXER_ENABLED=false`
  switches it off). Never set `ANTHROPIC_API_KEY` in the app's environment:
  the Claude Agent SDK sessions inherit it and would bill that key instead of
  the host's plan login.
- **File storage**: `SPACES_*` for an S3-compatible bucket, or nothing —
  `FILE_STORAGE=local` is the default without them, files under `files/`
  (`FILES_ROOT`) with signed links on the console host.
- **Channels**, each on when its variables are set: `TELEGRAM_BOT_TOKEN` and
  `TELEGRAM_ALLOWED_LOGINS` (the logins that may activate a group with
  `/start`; the bot needs a forum group with Topics); `CCR_ENABLED=true` for
  the Claude app's remote sessions (authenticated by the host's Claude CLI
  login). The console is always on.
- **Host logins for the agent backends** — installation-level facts, made
  once by the operator in a shell on the host, never by an agent:
  - Claude-based agents run on the host's Claude plan login — the Claude Code
    CLI installed and signed in (`~/.claude/.credentials.json`); the SDK
    brings its own CLI build and reads that login.
  - Codex-based agents (codex, image_generator) run on the host's ChatGPT
    login: `~/.codex/auth.json`, linked into the app's isolated
    `data/codex-home/` at the first session.
  - Claude Code Artifacts (the designer agent's medium — design canvases,
    design systems, decks on claude.ai) publish under that same host Claude
    login; nothing more to sign in.
- **The browser**: `npx playwright install chromium`. With `DISPLAY` set,
  Chromium runs headful on that X display (an Xvfb on the host, watched
  through noVNC) so the user can take over logins and CAPTCHAs; without it,
  headless. `BROWSER_PROXY_SERVER` routes the browser's traffic through an
  HTTP proxy when set.
- **The workbench's script runner** needs `python3` on the PATH (Node is the
  process itself).
- **Integrations** need nothing in `.env`: per-user OAuth (Gmail, Drive,
  Notion) runs through the platform with one redirect URI,
  `https://<CONSOLE_DOMAIN>/oauth/callback`, registered at each provider;
  installation OAuth clients (Google) and installation credentials
  (`${secret:NAME}` — Perplexity, Qase) are entered through one-time forms
  from the console's Connections page or the auth agent.

## Modes

- `npm run supervise` — production: build, then the app under the
  supervisor. `npm start` runs the built bundle bare (no relaunch on a
  requested restart).
- `npm run dev` — development: esbuild in watch mode (`build-dev`, an
  unminified bundle) plus nodemon relaunching the app on every change of
  `dist/`. `npm run stand` is the same with the rebuild delayed 3 s and the
  relaunch 6 s, so a burst of edits coalesces into one restart.
- `npm run build` — the whole bundle (server, console, apps vendor; also
  regenerates the Prisma client); `npm run build-console` — the console
  alone, live with the next page load.
- `npm run types` — tsc over the core and, separately, over the console.
- `npm test` — node's test runner over `src/**/*.test.ts` and
  `tools/**/*.test.ts`; the global setup starts an embedded PostgreSQL 16,
  deploys the migrations into a template and hands every test a copy; the
  live `DATABASE_URL` is taken away from the test children. Safe next to a
  running app.
- Offline scripts (`scripts/AGENTS.md`): `npm run render-context` — what each
  model actually sees, into `data/showcase/`; `npm run rebuild-threads` —
  the threads projection from the log, with the app stopped;
  `npm run import-sqlite`.

## First start

Migrations apply at boot. With an empty `workspaces` table the operator
workspace and its main thread are created on first need (one workspace needs
no `OPERATOR_WORKSPACE_ID`; several do). The console's `/login` page asks for
a code: the operator's is printed to the server log, a Telegram user's comes
from the bot's `/auth_code`. A Telegram group becomes a workspace with
`/start` from an allowlisted login.

## Extension points of an installation

Code and configs of the installation live in `data/` and are picked up at
boot (a task body at its fire) without a build — Node runs `.ts` natively:
`data/tools/<name>.ts` (an in-process tool server, `export start(ctx)`),
`data/mcp-servers/<name>.json` (an external MCP server), `data/remote-agents/
<name>.ts` (a remote agent kind with its driver), `data/workspace/<id>/tasks/
<slug>.ts` (a scheduled task body). Same contracts as their repository twins
(`src/capabilities/extensions.ts`); names never shadow the repository's; no
runtime imports from the repository tree — packages and `import type` only,
everything else arrives through `ctx`.

