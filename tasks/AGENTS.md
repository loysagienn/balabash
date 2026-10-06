# Scheduled task bodies — the workspace's tasks/ and the repository's tasks/

A `kind: 'code'` scheduled task is a registry row (the ScheduledTask table,
operated via the `schedule` tool server: create_task / list_tasks /
cancel_task / run_task) that says WHEN it fires, plus a run(ctx) body that
says WHAT it does. The slug joins the two. A body lives in one of two places:

- **The workspace** — `data/workspace/<userId>/tasks/<slug>.ts` (the
  directory is `$WORKSPACE_TASKS_DIR` in an agent session). A task is a
  workspace notion, so this is the normal home: the file is imported fresh
  at every fire — NO build, NO restart, an edit is live at the next moment;
  a broken file fails that run (system.exception), never the boot. Outside
  git, it travels with the workspace's data.
- **This repository directory** — bodies that are part of the product,
  shipped inside the app bundle through the static `tasks/index.ts`,
  validated hard at boot (a broken body fails the start and the supervisor
  rolls back to the last good bundle). Requires build + restart.

The repository wins a slug clash. The contract is the same in both places.

## Choosing the kind

Three kinds share the registry; only 'code' has a body here:

- `note` — natural-language intent, fired into the main thread, interpreted
  by the secretary. No engineering at all.
- `command` — a WORKSPACE JOB: a shell command (`bash -c`) run in the
  workspace file area (usually a project folder), hermetic environment
  (PATH/HOME/locale/TZ + WORKSPACE_DB), exit code is the whole protocol.
  Armed the moment the row exists — NO bundle, NO build, NO restart, no
  sleeping. Every run is journaled (list_job_runs / get_job_run); failure
  always surfaces as system.exception, success is silent unless
  report_on_success. Prefer this kind for user/workspace automations: a
  script collecting data into workspace.sqlite, a periodic export, anything
  deterministic that needs no LLM and nothing platform-internal.
- `code` — trusted code with ctx.prisma / ctx.tools: a workspace task file
  (live at the next fire) or a bundled body (build + restart).

## The contract

- One task = one file `<slug>.ts` exporting ONLY `async function run(ctx)`.
  Slugs match `^[a-z][a-z0-9_-]*$`.
- Workspace file: `$WORKSPACE_TASKS_DIR/<slug>.ts`, nothing else to register
  in code. Repository body: `tasks/<slug>.ts` plus the entry in the static
  index `tasks/index.ts` (same pattern as `agents/index.ts`).
- Validation: a module with extra exports or a non-function `run` is
  rejected — at boot for a bundled body, at fire time for a workspace file.
- Types come from `src/schedule/contract.ts` via `import type` only — NO
  runtime imports from the repository tree (a workspace file importing
  `src/...` would load a second copy of a bundled module); packages from
  node_modules are fine. Everything a body needs arrives through ctx.

## ctx

- `ctx.pushEvent(payload)` — journals a `schedule.fired` event addressed to
  the workspace's main thread, with the task's slug and name mixed into the
  payload. The task code does not choose the event type or the addressee.
  This is the ONLY trace a run leaves and the way to hand results to the
  coordinator. Keep payloads compact; push nothing when there is nothing to
  say.
- `ctx.prisma` — the app's database client (src/db/client.ts).
- `ctx.tools` — the workspace tool surface for the task's user: the
  repository servers of the task bundle (TASK_REPOSITORY_SERVERS in
  src/schedule/engine.ts) plus every extension server of the installation
  (data/tools, data/mcp-servers — see src/capabilities/extensions.ts); `list()` and
  `call(name, args)`. These calls are NOT journaled as tool.call.* (a task
  has no thread).

## Execution semantics

- Cron triggers are an alarm clock (evaluated in SCHEDULE_TIMEZONE, default
  Asia/Jerusalem): a moment missed while the app was down is skipped; the
  next one counts from "now". `at` means "not before this instant" and is
  consumed by firing — success or failure alike. No retries, no catch-up,
  no pause/resume. A task without a trigger runs only via run_task.
- Bodies run detached inside the app process. If a previous run of the same
  slug is still going when the trigger fires again, the new moment burns.
- An exception ends the run and is journaled as a system.exception into the
  main thread. Do not build retry machinery around it.
- Never block forever, never install timers, never restart or exit the
  process from inside a task.
- The `note` field of the registry row is IGNORED for code tasks.

## Shipping order

Workspace task (the default):

1. Write `$WORKSPACE_TASKS_DIR/<slug>.ts`.
2. `create_task` with kind `code` and the same slug (either order is fine).
3. Try it: `run_task` — the file is imported right there.

Repository task (product code only):

1. Write `tasks/<slug>.ts`, register it in `tasks/index.ts`.
2. `create_task` with kind `code` and the same slug.
3. `npm run types`, `npm run build`, `request_restart`.

Until a body exists the task SLEEPS: registered but body-less — the heart
does not arm it, run_task rejects it synchronously, and every boot journals
a system.exception per sleeping task. To edit a task's schedule or
metadata: cancel_task + create_task under the same slug (the body file
stays). To retire a code task: cancel_task and delete the file (a
repository body: remove it from the index in a later change).
