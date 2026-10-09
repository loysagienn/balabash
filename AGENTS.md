# Balabash — the repository

This is the source code of Balabash, a personal self-hosted assistant. An
agent working here is working on the very system it runs inside: the app
process serving the user right now is this code, loaded into memory. The
user of that app is its developer and operator — nothing internal is
confidential from them.

## Map

- `agents/` — the agent catalog: one declaration per agent, registered in the
  static index `agents/index.ts` (a new agent is a module plus an entry
  there). `agents/world/` is the world library: canonical prompt fragments,
  one file per world fact, every prompt imports instead of retelling.
  `agents/roles/` holds a brief shared by agents that play one role on
  different backends.
- `src/` — the app. `core/` (event log, envelopes, threads), `capabilities/`
  (tool servers, the tool manager, the agent runtime and session runner,
  agent validation), `coordinator/` (the secretary: instructions and
  function definitions), `harness/` (the model backends: `claude-sdk/`,
  `codex-sdk/`, `openai/`), `adapters/` (surfaces: `telegram/`, `ccr/`),
  `console/` (the new web interface: a browser SPA, its own tsconfig,
  served by the core on `CONSOLE_DOMAIN` through `src/api/console.ts`),
  `workspace/` (the per-user workbench: layout, sqlite, child processes),
  `projects/` (the project registry), `schedule/` (scheduled tasks and jobs),
  `apps/` (the mini-app platform), `files/` (file storage), `runtime/`
  (restart, router, runs), `test-support/` (the test PostgreSQL `npm test`
  starts: embedded-postgres, one migrated template, a copy per test;
  `db/test-guard.ts` keeps test children off the live database), `web/` (the
  previous Next.js UI, frozen: its own package, not developed further).
- `tasks/` — scheduled task bodies shipped with the product; `tasks/AGENTS.md`
  is their contract.
- `scripts/` — offline maintenance scripts (`scripts/AGENTS.md`); among them
  `render-context`, the verification instrument for any work on prompts and
  tool descriptions.
- `plugins/balabash/` — the platform plugin (skills) every full-preset agent
  session loads, whatever its working directory.
- `prisma/` — the database schema and its migrations; `prisma-generated/` is
  the generated client (`npm run build` regenerates it).
- `build/` — the esbuild configuration; `dist/` is the bundle output.
  `build/console.js` bundles `src/console` into `dist/console/` (hashed
  assets + `manifest.json`); the core reads the manifest per request, so
  `npm run build-console` goes live with the next page load — no restart.
- `data/` — runtime state (workspaces, supervisor, showcase output), not
  source.

## Rules of working on Balabash

- Verify your changes yourself with `npm run types` (tsc) and
  `npm run build`. Building is safe: the running app loaded its bundle into
  memory and is not affected by files on disk.
- NEVER start, stop or restart the Balabash app process yourself (no
  `npm start`, no `kill`, no supervisor commands). A live process is serving
  the user right now. Code changes go live only through an app restart,
  which is requested, not performed: `request_restart` records the request
  and the app restarts under the supervisor once every non-main thread is
  closed — so after requesting one, wrap up and end your thread to let it
  happen.
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
- Commit only when the user asks. Long-running processes and destructive
  host-level commands are out unless the user explicitly asks.

## Finishing a thread

The report must state what was changed, whether it was built, whether a
restart was requested, and anything that remains.
