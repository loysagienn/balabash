// Task execution — shared by the heart (due triggers) and the run_task tool
// (manual runs). For note/code, executing IS the whole story: runs leave no
// rows and no events of their own; a note task's fact is the schedule.fired
// append, a code task's memory is only what it pushes through ctx.pushEvent.
// Failures of code bodies are journaled as system.exception into the
// workspace's main thread; there are no retries. Workspace jobs (kind
// 'command') are the exception to "no rows": every run is journaled in
// JobRun — and events follow the attention rule (a failure always surfaces
// as system.exception; a success is silent unless report_on_success).

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { prisma } from '../db/client.ts';
import type { JsonObject, ToolsApi } from '../core/contract.ts';
import { appendEvent } from '../core/append.ts';
import { SCHEDULE_FIRED, SYSTEM_EXCEPTION } from '../core/envelope.ts';
import { getMainThread } from '../core/threads.ts';
import { callServerTool, getServerToolFunctions, type ToolBundle } from '../capabilities/tool-manager.ts';
import type { ScheduledTaskModel } from '../../prisma-generated/models.ts';
import { childEnv, runChild } from '../workspace/child.ts';
import { sanitizeRelPath } from '../workspace/files.ts';
import { workspaceDbPath, workspaceFilesDir } from '../workspace/layout.ts';
import { getTaskBody } from './catalog.ts';
import type { TaskContext } from './contract.ts';

// Workspace-job constants (agreed in the design): the kill timeout bounds,
// the journaled tail size per stream, and the fragments that ride in events.
export const JOB_TIMEOUT_DEFAULT_MS = 600_000;
export const JOB_TIMEOUT_MIN_MS = 1_000;
export const JOB_TIMEOUT_MAX_MS = 3_600_000;
const JOB_TAIL_MAX_CHARS = 16_384;
const JOB_STDERR_FRAGMENT_CHARS = 500;
const JOB_STDOUT_REPORT_CHARS = 1_000;

// A task's tool passport, listed explicitly like every agent's: tasks run
// with no native tools at all, so the workspace_files hands ride along;
// restart and auth are deliberately absent. Calls are NOT journaled as
// tool.call.* — the envelope requires an author thread and a task has none.
const TASK_BUNDLE: ToolBundle = {
  declared: [
    'current_datetime',
    'events',
    'gmail',
    'http_get',
    'notion',
    'perplexity',
    'projects',
    'schedule',
    'storage',
    'storage_download_file',
    'workspace',
    'workspace_files',
  ],
};

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// In-flight executions by slug (code bodies and command jobs alike): while a
// run is still going, a new fire moment for the same task burns — the heart
// skips it, run_task reports it.
const running = new Set<string>();

export function isTaskRunning(slug: string): boolean {
  return running.has(slug);
}

// In-flight workspace jobs by slug: the process-group id (pid of the detached
// child) and the JobRun id — the material of the shutdown sweep and of the
// restart safe-window predicate.
const runningJobs = new Map<string, { pid: number; runId: string }>();

// Runs killed by the shutdown sweep: their completion (if it lands before the
// process exits) is journaled as 'aborted', not 'failed', and pushes no event.
const abortedRuns = new Set<string>();

export function isAnyJobRunning(): boolean {
  return runningJobs.size > 0;
}

// Shutdown sweep: workspace jobs do not survive a restart — kill every
// running job's process group before the process exits. The journal rows are
// settled either by the in-flight completion handler (status 'aborted') or,
// after a hard death, by the boot sweep.
export function killRunningJobs(): void {
  for (const [slug, job] of runningJobs) {
    abortedRuns.add(job.runId);
    console.log(`[schedule] shutdown: killing workspace job "${slug}" (run ${job.runId}, pgid ${job.pid})`);

    try {
      process.kill(-job.pid, 'SIGKILL');
    } catch {
      // The group is already gone — the completion handler settles the row.
    }
  }
}

// Boot sweep: JobRun rows left 'running' by a dead process are settled as
// 'aborted' — the journal stays honest after any crash or restart.
export async function sweepAbortedJobRuns(): Promise<void> {
  try {
    const { count } = await prisma.jobRun.updateMany({
      where: { status: 'running' },
      data: { status: 'aborted', finishedAt: new Date() },
    });

    if (count > 0) {
      console.log(`[schedule] boot sweep: marked ${count} orphaned job run(s) as aborted`);
    }
  } catch (error) {
    console.error('[schedule] boot sweep of job runs failed:', error);
  }
}

// ToolsApi resolved for the task's user. threadId in the call context is the
// workspace's main thread: builtin servers and local tools use it only as the
// caller's attribution (e.g. file ingest), and the main thread is the one
// place a thread-less actor can honestly point at.
function createTaskToolsApi(userId: string, mainThreadId: string): ToolsApi {
  return {
    list: async () =>
      (await getServerToolFunctions(userId, TASK_BUNDLE)).map(fn => ({
        name: fn.functionName,
        description: fn.description,
        inputSchema: fn.inputSchema,
      })),

    call: async (name, args) => {
      const outcome = await callServerTool({ userId, threadId: mainThreadId }, TASK_BUNDLE, name, args);

      return outcome.result;
    },
  };
}

export type JobTrigger = 'cron' | 'at' | 'manual';

export type FireOutcome =
  // The action ran (a code body or a command job keeps running detached
  // after the return). runId is set for command jobs — the JobRun journal key.
  | { kind: 'fired'; runId?: string }
  // A previous run of the same code/command task is still going — this moment burns.
  | { kind: 'already_running' }
  // The workspace has no main thread to address — nothing to fire into.
  | { kind: 'no_main_thread' }
  // kind='code' with no body in the current process — the task sleeps.
  | { kind: 'sleeping' };

// Executes the task's action exactly as the heart does on a due trigger. The
// schedule itself is untouched here: consuming a one-shot row is the heart's
// business, not the action's.
export async function fireTask(task: ScheduledTaskModel, trigger: JobTrigger): Promise<FireOutcome> {
  const main = await getMainThread(task.userId);

  if (!main) {
    console.warn(`[schedule] task "${task.slug}": workspace ${task.userId} has no main thread; skipping`);

    return { kind: 'no_main_thread' };
  }

  const pushFired = async (payload: JsonObject) => {
    await appendEvent({
      type: SCHEDULE_FIRED,
      actor: 'system',
      userId: task.userId,
      threadId: null,
      targetThreadId: main.id,
      payload: { ...payload, slug: task.slug, name: task.name },
    });
  };

  if (task.kind === 'note') {
    await pushFired({ ...(task.note ? { note: task.note } : {}) });

    return { kind: 'fired' };
  }

  // The command branch stays strictly BEFORE the code path: a workspace job
  // has no body in the bundle, and falling through would misread it as a
  // sleeping code task.
  if (task.kind === 'command') {
    return fireCommandTask(task, trigger, main.id, pushFired);
  }

  const body = getTaskBody(task.slug);

  if (!body) {
    return { kind: 'sleeping' };
  }

  if (running.has(task.slug)) {
    return { kind: 'already_running' };
  }

  running.add(task.slug);

  const ctx: TaskContext = {
    pushEvent: pushFired,
    prisma,
    tools: createTaskToolsApi(task.userId, main.id),
  };

  // Detached: the body must not block the heart's pass. An exception is the
  // end of the run — journaled loudly, never retried.
  void (async () => {
    try {
      await body(ctx);
    } catch (error) {
      const message = getErrorMessage(error);

      console.error(`[schedule] task "${task.slug}" failed:`, error);

      await appendEvent({
        type: SYSTEM_EXCEPTION,
        actor: 'system',
        userId: task.userId,
        threadId: main.id,
        payload: { scope: 'scheduled-task', slug: task.slug, error: `Scheduled task "${task.slug}" failed: ${message}` },
      }).catch(appendError => {
        console.error(`[schedule] task "${task.slug}": failed to journal the failure:`, appendError);
      });
    } finally {
      running.delete(task.slug);
    }
  })();

  return { kind: 'fired' };
}

// ---------------------------------------------------------------------------
// Workspace jobs (kind 'command'): the registered shell command runs via
// `bash -c` in the workspace file area with the hermetic child environment
// (allowlist + WORKSPACE_DB — none of the app's secrets). The outcome
// protocol is the exit code alone: 0 = ok, anything else = failed; a timeout
// kills the whole process group. Every run is journaled in JobRun
// (fire-and-forget — telemetry failures never affect the run); events follow
// the attention rule: failure always → system.exception, success →
// schedule.fired only when report_on_success is set.
// ---------------------------------------------------------------------------

export function clampJobTimeout(timeoutMs: number | null): number {
  return Math.min(Math.max(timeoutMs ?? JOB_TIMEOUT_DEFAULT_MS, JOB_TIMEOUT_MIN_MS), JOB_TIMEOUT_MAX_MS);
}

function jobFailureText(
  slug: string,
  runId: string,
  status: 'failed' | 'timeout' | 'spawn_error',
  exitCode: number | null,
  stderr: string,
  timeoutMs: number,
): string {
  const what =
    status === 'timeout'
      ? `timed out after ${Math.round(timeoutMs / 1000)}s (process group killed)`
      : status === 'spawn_error'
        ? `failed to start: ${stderr || 'spawn error'}`
        : `failed with exit code ${exitCode ?? 'unknown'}`;
  const fragment = status === 'spawn_error' ? '' : stderr.slice(-JOB_STDERR_FRAGMENT_CHARS).trim();

  return (
    `Workspace job "${slug}" ${what}. Run ${runId} — full output via get_job_run.` +
    (fragment ? `\nstderr tail: ${fragment}` : '')
  );
}

function fireCommandTask(
  task: ScheduledTaskModel,
  trigger: JobTrigger,
  mainThreadId: string,
  pushFired: (payload: JsonObject) => Promise<void>,
): FireOutcome {
  if (running.has(task.slug)) {
    return { kind: 'already_running' };
  }

  running.add(task.slug);

  // The journal snapshot: the registry row may be gone (a consumed one-shot)
  // or recreated with a different command by the time anyone reads the run.
  const runId = randomUUID();
  const command = task.command ?? '';
  const cwd = task.cwd;
  const timeoutMs = clampJobTimeout(task.timeoutMs);
  const journalBase = { id: runId, userId: task.userId, slug: task.slug, command, cwd, trigger };

  // Fire-and-forget for the caller, but kept as a settled promise so the
  // completion write never races the start insert (an instant spawn error
  // could otherwise overtake it).
  const startInsert = prisma.jobRun.create({ data: { ...journalBase, status: 'running' } }).catch(error => {
    console.error(`[schedule] job "${task.slug}" (run ${runId}): failed to journal the start:`, error);
  });

  // Detached: the run must not block the heart's pass (nor run_task's reply).
  void (async () => {
    const startedAt = Date.now();
    let status: 'ok' | 'failed' | 'timeout' | 'spawn_error' = 'spawn_error';
    let exitCode: number | null = null;
    let durationMs = 0;
    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    try {
      const filesDir = workspaceFilesDir(task.userId);
      const absCwd = cwd ? path.join(filesDir, sanitizeRelPath(cwd, 'job cwd')) : filesDir;

      if (!command.trim()) {
        throw new Error('the registry row carries an empty command');
      }

      const outcome = await runChild('bash', ['-c', command], {
        cwd: absCwd,
        env: childEnv(workspaceDbPath(task.userId)),
        timeoutMs,
        maxOutputChars: JOB_TAIL_MAX_CHARS,
        capMode: 'tail',
        onSpawn: pid => runningJobs.set(task.slug, { pid, runId }),
      });

      exitCode = outcome.exitCode;
      durationMs = outcome.durationMs;
      stdout = outcome.stdout;
      stderr = outcome.stderr;
      stdoutTruncated = outcome.stdoutTruncated;
      stderrTruncated = outcome.stderrTruncated;
      status = outcome.timedOut ? 'timeout' : outcome.exitCode === 0 ? 'ok' : 'failed';
    } catch (error) {
      // Spawn failure (missing cwd, bash absent, a rejected cwd path…).
      status = 'spawn_error';
      stderr = getErrorMessage(error);
      durationMs = Date.now() - startedAt;
    } finally {
      running.delete(task.slug);
      runningJobs.delete(task.slug);
    }

    // A shutdown-sweep kill is not a failure of the job — the journal says
    // 'aborted' and no event fires (the restart was the actor, not the job).
    const finalStatus = abortedRuns.delete(runId) ? 'aborted' : status;

    await startInsert;

    // Upsert, not update: if the start insert was lost, the completion row
    // still lands whole.
    await prisma.jobRun
      .upsert({
        where: { id: runId },
        create: { ...journalBase, status: finalStatus },
        update: {},
      })
      .then(() =>
        prisma.jobRun.update({
          where: { id: runId },
          data: {
            status: finalStatus,
            exitCode,
            finishedAt: new Date(),
            durationMs,
            stdoutTail: stdout,
            stderrTail: stderr,
            stdoutTruncated,
            stderrTruncated,
          },
        }),
      )
      .catch(error => {
        console.error(`[schedule] job "${task.slug}" (run ${runId}): failed to journal the outcome:`, error);
      });

    if (finalStatus === 'aborted') {
      return;
    }

    if (finalStatus !== 'ok') {
      console.error(`[schedule] job "${task.slug}" (run ${runId}) ${finalStatus} (exit code ${exitCode ?? 'n/a'})`);

      await appendEvent({
        type: SYSTEM_EXCEPTION,
        actor: 'system',
        userId: task.userId,
        threadId: mainThreadId,
        payload: {
          scope: 'workspace-job',
          slug: task.slug,
          runId,
          status: finalStatus,
          ...(exitCode !== null ? { exitCode } : {}),
          error: jobFailureText(task.slug, runId, finalStatus, exitCode, stderr, timeoutMs),
        },
      }).catch(appendError => {
        console.error(`[schedule] job "${task.slug}" (run ${runId}): failed to journal the failure:`, appendError);
      });

      return;
    }

    if (task.reportOnSuccess) {
      await pushFired({ runId, output: stdout.slice(-JOB_STDOUT_REPORT_CHARS) }).catch(error => {
        console.error(`[schedule] job "${task.slug}" (run ${runId}): failed to push the success event:`, error);
      });
    }
  })();

  return { kind: 'fired', runId };
}
