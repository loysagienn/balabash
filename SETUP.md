# Setting up and running Balabash

What an installation of Balabash consists of, what it needs and how it is
started. `README.md` says what the system is; `DEVELOPMENT.md` is the guide
for working on the code.

## The process

One Node.js process (`dist/app.js`), started from the repository root — every
runtime path (`data/`, `dist/`, `files/`) resolves from the cwd. Programs and
workspace commands require Linux with a readable `/proc` to identify their
process groups. Boot order: sweep recorded groups in `data/process-groups/`
→ `prisma migrate deploy` → database check → tombstone of orphaned threads
without a saved session → agent catalog (repository agents, then
`data/remote-agents`) → external service settings → capability catalog → web server → channel adapters (Telegram and CCR
when configured) → resume of the surviving threads' runs → router, consumers,
schedule heart, indexer → restart module. The process listens on one
loopback port (`HTTP_PORT`); a TLS-terminating reverse proxy sends the whole
console host (and the apps host, if any) to it with `Host` and
`X-Forwarded-Proto` preserved.

Sessions of finished threads are not kept forever: once a day the app
deletes, through each SDK's own means (the Claude transcript with its
tool-results directory, the Codex rollout with its sqlite rows and generated
images), the sessions of threads finished more than `SESSION_RETENTION_DAYS`
ago (default 7), journaling `session.deleted` into the thread. Sessions that
accumulated before this existed are removed once with
`npm run cleanup-sessions` (`scripts/AGENTS.md`).

Code changes go live only through a restart. A requested restart waits for a
safe window — no agent or secretary turn in flight, no running program or command,
a settled remote engine and 20 s of log quiet; threads between turns keep their SDK sessions and resume
after it. In production the process runs
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
  `https://<CONSOLE_DOMAIN>/oauth/callback`, which Notion registers dynamically. The operator registers this URI with Google.
  Installation OAuth clients (Google) and installation credentials
  (such as the Perplexity API key) are entered through one-time forms
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
  `agents/**/*.test.ts`; the global setup starts an embedded PostgreSQL 16,
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

At boot, the catalog loads installation MCP servers from
`data/mcp-servers/<name>.json`. Node.js loads remote agent drivers directly from
`data/remote-agents/<name>.ts`. Drivers can import packages and repository types
with `import type`. They receive platform services through `ctx`.

### Written catalog nodes

Place one TypeScript module per top-level node in `data/nodes/<name>.ts`.
The filename supplies its snake_case name. Node.js loads the module at startup.
Use a subdirectory for helpers. Export a synchronous `define` function. Import
the contract as a **type** and use the catalog values passed by the running app:

```ts
import type { DefineInstallationNode } from '../../src/tree/authored-nodes.ts';

export const define: DefineInstallationNode = ({ capability, z }) => ({
  summary: 'Convert temperatures',
  recipients: ['general'],
  children: [capability({
    name: 'fahrenheit',
    summary: 'Convert Celsius to Fahrenheit',
    description: 'Return the temperature in degrees Fahrenheit.',
    input: z.strictObject({ celsius: z.number() }),
    output: z.number(),
    run: ({ celsius }) => celsius * 9 / 5 + 32,
  })],
});
```

Use `node` for nested groups, `namedType` for shared schemas and `CapabilityError`
for typed failures. Named types share a namespace with the repository and all installed nodes.
In a capability's `run(input, ctx)`, `files.ingest(ctx, { body, originalFilename, contentType, sizeBytes })`
stores bytes and returns a catalog `FileRef`. `files.open(ctx, fileId)` reads a stream from the caller's workspace.
Each connection follows the `Connection` type in `src/catalog/definition.ts`. The platform registers the service and supplies its authority
to calls. Agent or profile recipients receive the subtree subject to the workspace's
connections. An empty or omitted list leaves it available to scheduled programs only.
An unknown recipient produces a startup warning. A broken module or collision skips that file as a unit.
The System screen shows its filename and error under `nodes`.
Keep full names and service keys distinct from repository vertices, other installed
nodes and configured services. Restart Balabash to load changes.

### HTTP and stdio MCP servers

Place one JSON config per service in `data/mcp-servers/<name>.json`. Use a
unique snake_case name. The catalog reads every page of `tools/list` and
publishes the node under that name. Add agent or profile names to
`recipients` to grant the node. Scheduled programs use their workspace’s
full tree, including configured nodes with no agent recipients. The first
sentence of `description` (up to 175 characters) tells an agent when to
open the node. Configs containing `enabledTools` or `toolOverrides` are
rejected. Review the provider’s exposed tools before removing these fields.

```json
{
  "transport": "http",
  "url": "https://provider.example/mcp",
  "headers": { "Authorization": "Bearer ${secret:API_KEY}" },
  "description": "Search the installation’s document index.",
  "recipients": ["general"]
}
```

For stdio, set `"transport": "stdio"`, `command` and optional string
`args` and `env`. The MCP SDK runs the executable directly, with its default
inherited environment and the configured variables. Each discovery or call
starts its own process and closes it after the exchange. Use an executable
available to the service account from the application directory. A server
that needs a browser, session or other in-process state across calls is
incompatible with this transport lifecycle. The process should exit when
stdin closes to avoid a shutdown delay on every exchange.
Enter referenced installation secrets in Connections. A service without
secret references can publish at startup. Discovery runs on credential
changes and retries failures in the background. A failed refresh keeps the
last valid contract. Removing a key cuts the node from new grants and
refuses calls using an old grant.

For workspace OAuth, use HTTP with `"auth": "user"`, a `description` and
the provider’s MCP URL. Dynamic client registration is the default.
Use `"clientRegistration": "manual"` for an operator-provisioned client.
Optional `scope`, `authorizationParams` and `identityProbe` configure sign-in.
Sign-in, disconnect and loss of authorization refresh that workspace's
contract. Balabash publishes tools whose names and input/output schemas
match across the accounts that returned a list. A personalized title or
description comes from the first of those accounts in stable row order.
If no listing succeeds, the last valid contract stays available while an
account that supplied it remains. System names tools omitted from the snapshot.
Each call takes the workspace account address in `account`. That name is
reserved in the provider’s input schema. The provider receives its own
arguments and the selected account’s bearer token.

System shows configuration and discovery failures under `mcp-servers`,
with the JSON filename. OAuth discovery failures appear in the affected
workspace. Connections shows installation credential status. Restart to
reload edited files.

### claude.ai connectors

A claude.ai connector becomes a catalog node named after its file. Use a lower-case snake_case
name matching `[a-z][a-z0-9_]*` before `.json`. For example,
`data/mcp-servers/slack.json` can contain:

```json
{
  "transport": "claude-connector",
  "serverId": "mcpsrv_REPLACE",
  "description": "Search and send Slack workspace messages as the operator.",
  "recipients": ["general", "coordinator"]
}
```

Set the actual Anthropic MCP server id and the agent or profile names that
should receive the node. An empty or omitted list grants it to no agent.
Scheduled programs use the full installation tree. Calls in every workspace
act as the provider account linked in the operator’s claude.ai settings.
Connections shows the recipients and discovery or CLI login status. Claude
Code refreshes its login on this host; an environment token override must
be replaced by the operator. Change the provider account on claude.ai.
Edit or remove the JSON file and restart Balabash to change the local configuration.

### Remote agents

Remote kinds declare `modes` (for example `['user', 'headless']`),
`defaultMode` (one of those modes), and `recipients` (agent or access
profile names, e.g. `['coordinator', 'engineer']`). The shared access profiles,
including `general`, are defined in [agents/access.ts](agents/access.ts). A kind with no recipients
loads its driver for existing threads and is unavailable for new launches.
At cutover, add the recipients and both mode fields to installation
passports. An older passport omitting both mode fields supports both modes
and defaults to `user`.
