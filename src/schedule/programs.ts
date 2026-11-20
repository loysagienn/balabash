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
//   there. A run stopped with the app ('aborted') leaves its row and no
//   event: the restart was the actor, not the task. A restart waits until
//   the outcome of every run is journaled and told (hasUnsettledRuns).
//
// The catalog and the connections behind it are the tree's (src/tree), which
// itself reaches the schedule from its node `schedule`; so the tree hands
// both over when the app starts (setProgramHost), the way it tells its
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
import { appendEvent } from '../core/append.ts';
import type { JsonObject, Thread } from '../core/contract.ts';
import { SYSTEM_EXCEPTION } from '../core/envelope.ts';
import { prisma } from '../db/client.ts';
import type { FireOutcome, RunTrigger } from './engine.ts';
import { claimTask, releaseTask } from './running.ts';

// The limit of time of one run, in the registry row's milliseconds: what a
// task may ask for, and what it gets when it asked for nothing.
export const PROGRAM_TIMEOUT_DEFAULT_MS = 600_000;
export const PROGRAM_TIMEOUT_MIN_MS = 1_000;
export const PROGRAM_TIMEOUT_MAX_MS = 18_000_000;

export type ProgramHost = {
  catalog: Catalog;
  connections: ConnectionsPort;
};

let host: ProgramHost | null = null;

// The tree's word at the start of the app: the catalog scheduled programs
// call into and the connections its nodes work under.
export function setProgramHost(next: ProgramHost): void {
  host = next;
}

// The launches whose outcome is not yet in the journal and with the main
// thread. The process of a run may be gone while its row is still being
// settled and its value is on the way into the log: a restart that did not
// wait for that would leave a finished run 'aborted' and its value untold.
let unsettled = 0;

export function hasUnsettledRuns(): boolean {
  return unsettled > 0;
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

    const grant = await computeGrant(host.catalog, SCHEDULED, {
      caller: { workspaceId: task.workspaceId, threadId: main.id, agentName: main.agent },
      connections: host.connections,
    });

    return await executeProgram(
      grant,
      { code, timeoutMs: task.timeoutMs ?? PROGRAM_TIMEOUT_DEFAULT_MS, start },
      { connections: host.connections },
    );
  } catch (error) {
    return neverBegan(start, code, error);
  }
}

// Settles the row of the run. An outcome the database does not take (a NUL
// character in the console or in the value) still closes the row: the run
// is not left 'running' behind a process that is gone.
async function settle(run: ProgramRun): Promise<void> {
  const ended = { finishedAt: run.endedAt, durationMs: run.durationMs };

  try {
    await prisma.scheduleRun.update({
      where: { id: run.id },
      data: {
        ...ended,
        status: run.outcome,
        console: run.console,
        consoleTruncated: run.consoleTruncated,
        ...(run.outcome === 'ok'
          ? run.value === null
            ? {}
            : { value: run.value as Prisma.InputJsonValue, hasValue: true }
          : { error: run.error as Prisma.InputJsonValue }),
      },
    });
  } catch (error) {
    console.error(`[schedule] run ${run.id}: failed to journal the outcome:`, error);

    const message = `The run ended as ${run.outcome}, but its outcome could not be journaled: ${error instanceof Error ? error.message : String(error)}`;

    await prisma.scheduleRun
      .update({ where: { id: run.id }, data: { ...ended, status: 'failed', error: { kind: 'internal', message } } })
      .catch(again => {
        console.error(`[schedule] run ${run.id}: failed to close the journal row:`, again);
      });
  }
}

function failureText(slug: string, run: ProgramRun & { error: CapabilityErrorValue }): string {
  return (
    `Scheduled task "${slug}" ${run.outcome === 'timeout' ? 'ran out of time' : 'failed'} — ${run.error.kind}: ${run.error.message} ` +
    `Run ${run.id}: \`schedule_get_run\` gives its code and its console output.`
  );
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
  if (!claimTask(task.slug)) {
    return { kind: 'already_running' };
  }

  // The journal snapshot: the registry row may be gone (a consumed one-shot)
  // or recreated with other code by the time anyone reads the run.
  const start: ProgramStart = { id: randomUUID(), startedAt: new Date() };
  const code = task.code ?? '';

  try {
    await prisma.scheduleRun.create({
      data: { id: start.id, workspaceId: task.workspaceId, slug: task.slug, trigger, code, status: 'running', startedAt: start.startedAt },
    });
  } catch (error) {
    releaseTask(task.slug);

    throw error;
  }

  unsettled += 1;

  void (async () => {
    const run = await runUnderMainThread(task, main, start, code).finally(() => releaseTask(task.slug));

    await settle(run);

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

    if (run.outcome !== 'ok') {
      console.error(`[schedule] task "${task.slug}" (run ${run.id}) ${run.outcome}: ${run.error.message}`);
      await exception(run.outcome, failureText(task.slug, run));

      return;
    }

    if (run.value === null) {
      return;
    }

    try {
      await pushFired({ runId: run.id, value: run.value as JsonObject[string] });
    } catch (error) {
      console.error(`[schedule] task "${task.slug}" (run ${run.id}): failed to deliver the value:`, error);
      await exception(
        'ok',
        `Scheduled task "${task.slug}" returned a value that could not be delivered to the main thread: ${error instanceof Error ? error.message : String(error)}. ` +
          `Run ${run.id}: \`schedule_get_run\` gives the value.`,
      );
    }
  })().finally(() => {
    unsettled -= 1;
  });

  return { kind: 'fired', runId: start.id };
}

// Boot sweep: a run does not survive the app. A row left 'running' by the
// previous process — stopped by force or dead — is settled as 'aborted'.
export async function sweepAbortedRuns(): Promise<void> {
  try {
    const { count } = await prisma.scheduleRun.updateMany({
      where: { status: 'running' },
      data: { status: 'aborted', finishedAt: new Date() },
    });

    if (count > 0) {
      console.log(`[schedule] boot sweep: marked ${count} orphaned program run(s) as aborted`);
    }
  } catch (error) {
    console.error('[schedule] boot sweep of program runs failed:', error);
  }
}
