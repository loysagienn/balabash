# Working on the Balabash repository

Read this before changing anything here. This is the source code of Balabash,
a personal self-hosted assistant (`README.md` says what it is and what it
does; `SETUP.md` — how an installation is configured, started and run). An
agent working here is usually working on the very system it runs inside: the
app process serving the user right now is this code, loaded into memory. The
user of that app is its developer and operator — nothing internal is
confidential from them.

## Map

- `agents/` — the agent catalog: one declaration per agent, registered in the
  static index `agents/index.ts` (a new agent is a module plus an entry
  there). `agents/world/` is the world library: canonical prompt fragments,
  one file per world fact, every prompt imports instead of retelling.
  `agents/roles/` holds a brief shared by agents that play one role on
  different backends; `agents/kit/` — pieces shared by agent modules (the
  Playwright MCP of the agents that carry a browser, the loopback static
  server an agent renders its workbench files from).
- `tools/` — the repository's in-process tool servers (MCP over loopback
  HTTP): the workbench (`workspace`, `workspace_files`), `gmail` and `drive`
  over the shared Google plumbing, `http_get`, `apps`, … registered in
  `tools/index.ts`. `mcp-servers/` — the JSON configs of external MCP servers
  (Notion, Perplexity, Qase).
- `src/` — the app. `core/` (event log, envelopes, threads), `capabilities/`
  (tool servers, the tool manager, the agent runtime and session runner,
  agent validation, per-user connections and installation secrets),
  `coordinator/` (the secretary: instructions and function definitions),
  `harness/` (the model backends: `claude-sdk/`, `codex-sdk/`, `openai/`,
  `anthropic/`), `adapters/` (surfaces: `telegram/`, `ccr/`), `api/` (the
  Koa web surface: `/api`, `/files`, the one-time links and the OAuth
  callback), `console/` (the web interface: a browser SPA, its own tsconfig,
  served by the core on `CONSOLE_DOMAIN` through `src/api/console.ts`),
  `users/` (users, identities, workspace membership), `workspace/` (the
  per-workspace workbench: layout, sqlite, child processes, the annotation
  indexer), `projects/` (the project registry), `schedule/` (scheduled tasks
  and jobs; `schedule/AGENTS.md` — the contract of task bodies, which live in
  the workspace, not in the repository), `remote/` (remote agents: an
  external system's session mirrored as a thread; `remote/AGENTS.md` — the
  pieces and the invariants; the drivers live in the installation's
  `data/remote-agents/`, not in the repository), `apps/` (the mini-app
  platform), `files/` (file storage: the `spaces` and `local` drivers),
  `drafts/` (message drafts), `runtime/` (restart, router, runs, telemetry),
  `test-support/` (the test PostgreSQL `npm test` starts: embedded-postgres,
  one migrated template, a copy per test; `stand.ts` — the stand of one test
  file: the app's modules over their own copy and file area, reached over
  HTTP; `db/test-guard.ts` keeps test children off the live database).
- `scripts/` — offline maintenance scripts (`scripts/AGENTS.md`); among them
  `render-context`, the verification instrument for any work on prompts and
  tool descriptions, and `patch-sdk-bridge.mjs`, run by `postinstall` and
  every build.
- `plugins/balabash/` — the platform plugin (skills) every full-preset agent
  session loads, whatever its working directory; Codex sessions get the same
  skills linked into their home.
- `prisma/` — the database schema and its migrations; `prisma-generated/` is
  the generated client (`npm run build` regenerates it).
- `build/` — the esbuild configuration; `dist/` is the bundle output
  (`app.js` and the offline scripts, `console/`, `apps-vendor/`).
  `build/console.js` bundles `src/console` into `dist/console/` (hashed
  assets + `manifest.json`); the core reads the manifest per request, so
  `npm run build-console` goes live with the next page load — no restart.
- `supervisor.js` — the restart-on-exit loop the production process runs
  under; dependency-free, changed by hand only.
- `data/` — runtime state and installation extensions (gitignored):
  `workspace/<workspaceId>/` (the workbench: `workspace.sqlite`, `files/`,
  `tmp/`, `tasks/`), `agent-state/`, `codex-home/`, `supervisor/`,
  `showcase/` (render-context output), and the extensions below.
- `.env` — the installation's configuration; `.env.example` documents every
  variable (`SETUP.md`).

## Rules of working on Balabash

- Verify your changes yourself with `npm run types` (tsc) and
  `npm run build`. Building is safe: the running app loaded its bundle into
  memory and is not affected by files on disk. `npm test` is safe too — it
  runs on its own PostgreSQL.
- NEVER start, stop or restart the Balabash app process yourself (no
  `npm start`, no `npm run dev`, no `kill`, no supervisor commands). A live
  process is serving the user right now. Code changes go live only through
  an app restart, which is requested, not performed: `request_restart`
  records the request and the app restarts under the supervisor once every
  non-main thread is closed — so after requesting one, wrap up and end your
  thread to let it happen.
- Database schema changes ride the same restart: edit `prisma/schema.prisma`,
  author an SQL migration into
  `prisma/migrations/<timestamp>_<name>/migration.sql`
  (`npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script`
  — the datasource comes from `prisma.config.ts`),
  and let the boot-time `prisma migrate deploy` apply it — never apply
  schema changes to the live database by hand, never edit an already-applied
  migration. Migrations must be additive and backward-compatible (new
  tables, new nullable columns); renames and drops go into a later change
  once no running code references them. A migration that fails to apply
  does not stop the boot — it is journaled (`migrationsFailed` on
  `system.restart.completed`) and blocks later migrations until fixed and
  resolved with `prisma migrate resolve --rolled-back <name>`.
- Prompt and tool-description work: run `npm run build && npm run
  render-context` before and after the change and diff `data/showcase/` —
  the output is what the models actually see.
- Host logins, `.env` and the reverse proxy are the operator's: when a
  credential, a login or a service is missing, say what is needed instead of
  working around it.
- Commit only when the user asks. Long-running processes and destructive
  host-level commands are out unless the user explicitly asks.

## Finishing a thread

The report must state what was changed, whether it was built, whether a
restart was requested, and anything that remains.
