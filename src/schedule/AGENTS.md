# Scheduled tasks

A scheduled task is a registry row (the ScheduledTask table) that says WHEN
it fires and WHAT it does. The scheme of capabilities knows two kinds
(the node `schedule` of the catalog, `src/tree/schedule.ts`):

- `note` — a text for the secretary: at the trigger it lands in the main
  thread as a `schedule.fired` event, and the secretary acts on it.
- `program` — code kept in the row itself and run at the trigger by the
  catalog's runner (`programs.ts` over `src/catalog/program.ts`): a process
  of its own per run, only `call`, `describe` and `console` in scope, as
  the task in the workspace's main thread with the whole tree but `end_thread`
  and `view_file`, for up to 5 hours. Every run is a row of the journal of
  scheduled runs (ScheduleRun; read by `journal.ts`); what the program
  returns comes to the main thread as `schedule.fired` (null is silence), a
  failure or a timeout as `system.exception`, a run stopped by a restart is
  `aborted` and tells nobody.

Every task carries the flag `wake`: `false` leaves its `schedule.fired` to
wait in the main thread for the secretary's next turn.

## Triggers and execution

- Cron triggers are an alarm clock (evaluated in SCHEDULE_TIMEZONE, default
  Asia/Jerusalem): a moment missed while the app was down is skipped; the
  next one counts from "now". `at` means "not before this instant" and is
  consumed by firing — success or failure alike. No retries, no catch-up,
  no pause/resume. A task without a trigger runs only via schedule_run_task.
- A trigger during a previous run of the same task is skipped. A manual run
  leaves the trigger untouched.
- To schedule a workspace script, call `workspace_run_command` from a program.
