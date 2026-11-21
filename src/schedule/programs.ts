// A scheduled program: the launch of a task of kind 'program'. The runner is
// the catalog's (src/catalog/program.ts) — the same code, the same process
// per run, the same content of the record as a launch on the spot; what
// differs is the launcher's to say, and here the launcher is the schedule:
//
// - whose grant: the main thread of the task's workspace, with the whole
//   tree but `end_thread` (the main thread never ends) and `view_file` (the
//   content of a file is shown only to a model), computed at the moment of
//   the run — what is connected then is what the program has;
// - how long: the task's own limit, up to 5 hours;
// - where the record is: the journal of scheduled runs (ScheduleRun). The
//   schedule names the run, writes the row as 'running' and only then
//   launches; the same row is settled when the run ends. No row — no run;
// - who gets the value: the main thread, as a schedule.fired event; null is
//   silence. A run that failed or ran out of time is a system.exception
//   there. The main thread is told what the journal holds of the run, not
//   what the runner gave: an outcome the journal did not take is a failure
//   there and a failure here. A run stopped with the app ('aborted') leaves
//   its row and no event: the restart was the actor, not the task.
//
// A launch is in flight from the moment its task is taken until the outcome
// is journaled and told: for that long the task says it is running, a
// restart waits (hasUnsettledRuns), and the boot sweep leaves the row alone.
//
// The catalog and its connections are the tree's (src/tree), which
// itself reaches the schedule from its node `schedule`; so the tree hands
// these over when the app starts (setProgramHost), the way it tells its
// services to the connections layer.

import { randomUUID } from 'node:crypto';
import type { ScheduledTaskModel } from '../../prisma-generated/models.ts';
import { Prisma } from '../../prisma-generated/client.ts';
import {
  CapabilityError,
  computeGrant,
  executeProgram,
  toCapabilityError,
  type CapabilityErrorValue,
  type Catalog,
  type ConnectionsPort,
  type GrantPolicy,
  type ProgramRun,
  type ProgramStart,
} from '../catalog/index.ts';
import { appendEvent, storablePayload } from '../core/append.ts';
import type { JsonObject, Thread } from '../core/contract.ts';
import { SYSTEM_EXCEPTION } from '../core/envelope.ts';
import { prisma } from '../db/client.ts';
import type { FireOutcome } from './engine.ts';
import type { RunTrigger } from './run-record.ts';

// The limit of time of one run, in the registry row's milliseconds: what a
// task may ask for, and what it gets when it asked for nothing.
export const PROGRAM_TIMEOUT_DEFAULT_MS = 600_000;
export const PROGRAM_TIMEOUT_MIN_MS = 1_000;
export const PROGRAM_TIMEOUT_MAX_MS = 18_000_000;

export type ProgramHost = {
  catalog(workspaceId: string): Catalog;
  connections: ConnectionsPort;
};

let host: ProgramHost | null = null;

// The tree's word at the start of the app: the catalog scheduled programs
// call into and the connections its nodes work under.
export function setProgramHost(next: ProgramHost): void {
  host = next;
}

// The launches of this process in flight, by task slug and run id: from the
// moment a task is taken — before its row is written — until its outcome is
// in the journal and with the main thread. The process of a run may not be
// there yet, or be gone already, while the row is being written and the
// value is on the way into the log: a restart that did not wait for that
// would leave a taken moment without a run, or a finished run 'aborted' and
// its value untold.
const runsBySlug = new Map<string, string>();

export function isTaskRunning(slug: string): boolean {
  return runsBySlug.has(slug);
}

export function hasUnsettledRuns(): boolean {
  return runsBySlug.size > 0;
}

// What a scheduled program is cut off from, whatever else the tree holds.
const CUT_OFF: ReadonlySet<string> = new Set(['end_thread', 'view_file']);

// A program has `call` and `describe` in scope and nothing else: programs
// do not nest.
const SCHEDULED: GrantPolicy = {
  allows: vertex => !CUT_OFF.has(vertex.fullName),
  actions: ['describe', 'call'],
};

// The run of a program that never began: whatever kept it from beginning is
// how it ended.
function neverBegan(start: ProgramStart, code: string, error: unknown): ProgramRun {
  const endedAt = new Date();

  return {
    id: start.id,
    code,
    startedAt: start.startedAt,
    endedAt,
    durationMs: endedAt.getTime() - start.startedAt.getTime(),
    console: '',
    consoleTruncated: false,
    outcome: 'failed',
    value: null,
    error: toCapabilityError(error).toValue(),
  };
}

async function runUnderMainThread(task: ScheduledTaskModel, main: Thread, start: ProgramStart, code: string): Promise<ProgramRun> {
  try {
    if (!host) {
      throw new CapabilityError('internal', 'The catalog is not started: the schedule has nothing to run a program against.');
    }

    const grant = await computeGrant(host.catalog(task.workspaceId), SCHEDULED, {
      caller: { workspaceId: task.workspaceId, threadId: main.id, agentName: main.agent },
      connections: host.connections,
    });

    return await executeProgram(
      grant,
      { code, timeoutMs: task.timeoutMs ?? PROGRAM_TIMEOUT_DEFAULT_MS, start, task: task.slug },
      { connections: host.connections },
    );
  } catch (error) {
    return neverBegan(start, code, error);
  }
}

// Settles the row of the run and gives the run as the journal now holds it —
// what `schedule_get_run` will say, and so what the main thread is told.
// The row takes strings the way the event log does (U+0000 replaced: neither
// text nor jsonb holds it), so the value in the journal and the value in the
// event are one. An outcome the database still does not take closes the row
// all the same — the run is not left 'running' behind a process that is
// gone: as 'failed' with an internal error and nothing of what the run left
// (a run stopped with the app stays 'aborted'). null: the row could not be
// closed at all.
async function settle(run: ProgramRun): Promise<ProgramRun | null> {
  const ended = { finishedAt: run.endedAt, durationMs: run.durationMs };
  const left = storablePayload({ console: run.console, value: run.value, error: run.error });

  try {
    await prisma.scheduleRun.update({
      where: { id: run.id },
      data: {
        ...ended,
        status: run.outcome,
        console: left.console as string,
        consoleTruncated: run.consoleTruncated,
        ...(run.outcome === 'ok'
          ? run.value === null
            ? {}
            : { value: left.value as Prisma.InputJsonValue, hasValue: true }
          : { error: left.error as Prisma.InputJsonValue }),
      },
    });

    return run;
  } catch (error) {
    console.error(`[schedule] run ${run.id}: failed to journal the outcome:`, error);

    const nothing = { console: '', consoleTruncated: false };
    const closed: ProgramRun =
      run.outcome === 'aborted'
        ? { ...run, ...nothing }
        : {
            ...run,
            ...nothing,
            outcome: 'failed',
            value: null,
            error: {
              kind: 'internal',
              message: `The run ended as ${run.outcome}, but the journal did not take its outcome: ${error instanceof Error ? error.message : String(error)}`,
            },
          };

    try {
      await prisma.scheduleRun.update({
        where: { id: run.id },
        data: { ...ended, status: closed.outcome, ...(closed.outcome === 'aborted' ? {} : { error: closed.error as Prisma.InputJsonValue }) },
      });

      return closed;
    } catch (again) {
      console.error(`[schedule] run ${run.id}: failed to close the journal row:`, again);

      return null;
    }
  }
}

function failureText(slug: string, run: ProgramRun & { error: CapabilityErrorValue }): string {
  return (
    `Scheduled task "${slug}" ${run.outcome === 'timeout' ? 'ran out of time' : 'failed'} — ${run.error.kind}: ${run.error.message} ` +
    `Run ${run.id}: \`schedule_get_run\` gives the error with its details, the code and the console output.`
  );
}

// Tells the main thread how a run ended, by what the journal holds of it.
async function tell(task: ScheduledTaskModel, main: Thread, run: ProgramRun, pushFired: (payload: JsonObject) => Promise<void>): Promise<void> {
  const kept = await settle(run);

  // A run stopped with the app tells nobody, whatever became of its row: a
  // row left open is closed by the boot sweep of the next process.
  if (run.outcome === 'aborted') {
    return;
  }

  const exception = (status: string, error: string) =>
    appendEvent({
      type: SYSTEM_EXCEPTION,
      actor: 'system',
      workspaceId: task.workspaceId,
      threadId: main.id,
      payload: { scope: 'scheduled-program', slug: task.slug, runId: run.id, status, error },
    }).catch(appendError => {
      console.error(`[schedule] task "${task.slug}" (run ${run.id}): failed to journal the failure:`, appendError);
    });

  if (!kept) {
    await exception(
      run.outcome,
      `Scheduled task "${task.slug}": its run ${run.id} ended as ${run.outcome}, but the journal of runs could not be written and nothing the run left is kept. ` +
        `The journal shows the run as running until the next start of the app closes it as aborted.`,
    );

    return;
  }

  if (kept.outcome !== 'ok') {
    console.error(`[schedule] task "${task.slug}" (run ${run.id}) ${kept.outcome}: ${kept.error.message}`);
    await exception(kept.outcome, failureText(task.slug, kept));

    return;
  }

  if (kept.value === null) {
    return;
  }

  try {
    await pushFired({ runId: run.id, value: kept.value as JsonObject[string] });
  } catch (error) {
    console.error(`[schedule] task "${task.slug}" (run ${run.id}): failed to deliver the value:`, error);
    await exception(
      'ok',
      `Scheduled task "${task.slug}" returned a value that could not be delivered to the main thread: ${error instanceof Error ? error.message : String(error)}. ` +
        `Run ${run.id}: \`schedule_get_run\` gives the value.`,
    );
  }
}

// Runs the program of a task. The answer comes as soon as the run has its
// row in the journal; the run itself goes on detached and tells the main
// thread how it ended. A failure to write the row is the failure of the
// launch: nothing runs.
export async function fireProgramTask(
  task: ScheduledTaskModel,
  trigger: RunTrigger,
  main: Thread,
  pushFired: (payload: JsonObject) => Promise<void>,
): Promise<FireOutcome> {
  if (isTaskRunning(task.slug)) {
    return { kind: 'already_running' };
  }

  // The journal snapshot: the registry row may be gone (a consumed one-shot)
  // or recreated with other code by the time anyone reads the run.
  const start: ProgramStart = { id: randomUUID(), startedAt: new Date() };
  const code = task.code ?? '';

  // In flight from here, before the first wait; over when the outcome is
  // journaled and told — only then is the task free for its next run: a
  // program that reads its previous value from the journal finds it there.
  runsBySlug.set(task.slug, start.id);

  const over = () => {
    runsBySlug.delete(task.slug);
  };

  try {
    await prisma.scheduleRun.create({
      data: { id: start.id, workspaceId: task.workspaceId, slug: task.slug, trigger, code, status: 'running', startedAt: start.startedAt },
    });
  } catch (error) {
    over();

    throw error;
  }

  void runUnderMainThread(task, main, start, code)
    .then(run => tell(task, main, run, pushFired))
    .catch(error => {
      console.error(`[schedule] task "${task.slug}" (run ${start.id}): the run was not seen to its end:`, error);
    })
    .finally(over);

  return { kind: 'fired', runId: start.id };
}

// Boot sweep: a run does not survive the app. A row left 'running' by the
// previous process is settled as 'aborted'.
// The launches of this process are not its business; the app sweeps before
// it opens anything a run can start from (src/app.ts).
export async function sweepAbortedRuns(): Promise<void> {
  try {
    const { count } = await prisma.scheduleRun.updateMany({
      where: { status: 'running', id: { notIn: [...runsBySlug.values()] } },
      data: { status: 'aborted', finishedAt: new Date() },
    });

    if (count > 0) {
      console.log(`[schedule] boot sweep: marked ${count} orphaned program run(s) as aborted`);
    }
  } catch (error) {
    console.error('[schedule] boot sweep of program runs failed:', error);
  }
}
