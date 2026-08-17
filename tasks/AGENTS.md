# tasks/ — scheduled task bodies

This directory holds the run(ctx) bodies of `kind: 'code'` scheduled tasks.
The registry (the ScheduledTask table, operated via the `schedule` tool
server: create_task / list_tasks / cancel_task / run_task) says WHEN a task
fires; a file here says WHAT it does. The slug joins the two.

## The contract

- One task = one file `tasks/<slug>.ts` exporting ONLY `async function run(ctx)`.
- The slug is the key in the static index `tasks/index.ts` — add the import
  and the entry there (same pattern as `agents/index.ts`). Slugs match
  `^[a-z][a-z0-9_-]*$`.
- Bodies ship inside the app bundle; validation is hard at boot — a module
  with extra exports or a non-function `run` fails the start (the supervisor
  then rolls back to the last good bundle).
- Types come from `src/schedule/contract.ts` via `import type` only — no
  runtime imports from the bundle.

## ctx

- `ctx.pushEvent(payload)` — journals a `schedule.fired` event addressed to
  the workspace's main thread, with the task's slug and name mixed into the
  payload. The task code does not choose the event type or the addressee.
  This is the ONLY trace a run leaves and the way to hand results to the
  coordinator. Keep payloads compact; push nothing when there is nothing to
  say.
- `ctx.prisma` — the app's database client (src/db/client.ts).
- `ctx.tools` — the workspace tool surface for the task's user: the task
  bundle's tool servers (TASK_BUNDLE in src/schedule/engine.ts);
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

1. Write `tasks/<slug>.ts`.
2. Register it in `tasks/index.ts`.
3. `create_task` with kind `code` and the same slug (either order with 1–2
   is fine — but close the gap promptly).
4. `npm run build` (and `npm run types` first).
5. `request_restart`.

Until the restart boots the new bundle the task SLEEPS: registered but
body-less — the heart does not arm it, run_task rejects it synchronously,
and every boot journals a system.exception per sleeping task. To edit a
task's schedule or metadata: cancel_task + create_task under the same slug
(the body file stays). To retire a code task: cancel_task, and remove the
body from the index in a later change.
