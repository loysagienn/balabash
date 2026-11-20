// The former kinds of a scheduled task — 'code' (a run(ctx) body file of the
// workspace, imported into the app's process) and 'command' (a workspace
// job: a shell command journaled in JobRun) — and their executor. The scheme
// of capabilities knows two kinds, 'note' and 'program' (engine.ts,
// programs.ts); a row of a former kind is still run here until the registry
// is moved to programs, and this file leaves with it, together with
// catalog.ts and contract.ts (the body files) and the JobRun writes.
//
// A code body leaves no rows and no events of its own: its memory is only
// what it pushes through ctx.pushEvent; its failure is a system.exception in
// the main thread. A workspace job is journaled in JobRun, and its events
// follow the attention rule (a failure always surfaces as system.exception;
// a success is silent unless report_on_success).

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { prisma } from '../db/client.ts';
import type { JsonObject, ToolsApi } from '../core/contract.ts';
import { appendEvent } from '../core/append.ts';
import { SYSTEM_EXCEPTION } from '../core/envelope.ts';
import {
  callServerTool,
  getServerToolFunctions,
  type ToolBundle,
} from '../capabilities/tool-manager.ts';
import type { ScheduledTaskModel } from '../../prisma-generated/models.ts';
import { childEnv, runChild } from '../workspace/child.ts';
import { sanitizeRelPath } from '../workspace/files.ts';
import { workspaceDbPath, workspaceFilesDir } from '../workspace/layout.ts';
import { loadTaskBody, locateTaskBody } from './catalog.ts';
import type { TaskContext } from './contract.ts';
import type { FireOutcome, RunTrigger } from './engine.ts';
import { claimTask, releaseTask } from './running.ts';

// Workspace-job constants (agreed in the design): the kill timeout bounds,
// the journaled tail size per stream, and the fragments that ride in events.
export const JOB_TIMEOUT_DEFAULT_MS = 600_000;
export const JOB_TIMEOUT_MIN_MS = 1_000;
export const JOB_TIMEOUT_MAX_MS = 18_000_000; // 5 hours: room for long nightly jobs
const JOB_TAIL_MAX_CHARS = 16_384;
const JOB_STDERR_FRAGMENT_CHARS = 500;
const JOB_STDOUT_REPORT_CHARS = 1_000;

// A task's tool passport: the repository servers are listed explicitly like
// every agent's (tasks run with no native tools at all, so the
// workspace_files hands ride along; restart and auth are deliberately
// absent). It names "projects", so the installation's extension servers
// (data/tools, data/mcp-servers — the operator's own code and configs,
// src/capabilities/extensions.ts) come along by the bundle rule of
// src/capabilities/tool-manager.ts, as for every such passport.
// Calls are NOT journaled as tool.call.* — the envelope requires an author
// thread and a task has none.
const TASK_REPOSITORY_SERVERS = [
    'current_datetime',
    'events',
    'drive',
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
];

function taskBundle(): ToolBundle {
  return { declared: [...TASK_REPOSITORY_SERVERS] };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

// How many workspace jobs are in flight — the child processes of the
// schedule (the console's System screen).
export function countRunningJobs(): number {
  return runningJobs.size;
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

// ToolsApi resolved for the task's workspace. threadId in the call context is the
// workspace's main thread: builtin servers and local tools use it only as the
// caller's attribution (e.g. file ingest), and the main thread is the one
// place a thread-less actor can honestly point at.
function createTaskToolsApi(workspaceId: string, mainThreadId: string): ToolsApi {
  return {
    list: async () =>
      (await getServerToolFunctions(workspaceId, taskBundle())).map(fn => ({
        name: fn.functionName,
        description: fn.description,
        inputSchema: fn.inputSchema,
      })),

    call: async (name, args) => {
      const outcome = await callServerTool({ workspaceId, threadId: mainThreadId }, taskBundle(), name, args);

      return outcome.result;
    },
  };
}

// A code task: the body file is imported fresh and run detached inside the
// app's process. No file — the task sleeps.
export async function fireCodeTask(
  task: ScheduledTaskModel,
  mainThreadId: string,
  pushFired: (payload: JsonObject) => Promise<void>,
): Promise<FireOutcome> {
  const file = await locateTaskBody(task.workspaceId, task.slug);

  if (!file) {
    return { kind: 'sleeping' };
  }

  if (!claimTask(task.slug)) {
    return { kind: 'already_running' };
  }

  const ctx: TaskContext = {
    workspaceId: task.workspaceId,
    pushEvent: pushFired,
    prisma,
    tools: createTaskToolsApi(task.workspaceId, mainThreadId),
  };

  // Detached: the body must not block the heart's pass. An exception is the
  // end of the run — journaled loudly, never retried. The body is imported
  // here, fresh: a broken file is this run's failure, not the heart's.
  void (async () => {
    try {
      const body = await loadTaskBody(file);

      await body(ctx);
    } catch (error) {
      const message = getErrorMessage(error);

      console.error(`[schedule] task "${task.slug}" failed:`, error);

      await appendEvent({
        type: SYSTEM_EXCEPTION,
        actor: 'system',
        workspaceId: task.workspaceId,
        threadId: mainThreadId,
        payload: { scope: 'scheduled-task', slug: task.slug, error: `Scheduled task "${task.slug}" failed: ${message}` },
      }).catch(appendError => {
        console.error(`[schedule] task "${task.slug}": failed to journal the failure:`, appendError);
      });
    } finally {
      releaseTask(task.slug);
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

export async function fireCommandTask(
  task: ScheduledTaskModel,
  trigger: RunTrigger,
  mainThreadId: string,
  pushFired: (payload: JsonObject) => Promise<void>,
): Promise<FireOutcome> {
  if (!claimTask(task.slug)) {
    return { kind: 'already_running' };
  }

  // The journal snapshot: the registry row may be gone (a consumed one-shot)
  // or recreated with a different command by the time anyone reads the run.
  const runId = randomUUID();
  const command = task.command ?? '';
  const cwd = task.cwd;
  const timeoutMs = clampJobTimeout(task.timeoutMs);
  const journalBase = { id: runId, workspaceId: task.workspaceId, slug: task.slug, command, cwd, trigger };

  // Both the caller reading the run id and the job writing its outcome
  // can reach the journal as soon as the start insert settles.
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
      const filesDir = workspaceFilesDir(task.workspaceId);
      const absCwd = cwd ? path.join(filesDir, sanitizeRelPath(cwd, 'job cwd')) : filesDir;

      if (!command.trim()) {
        throw new Error('the registry row carries an empty command');
      }

      const outcome = await runChild('bash', ['-c', command], {
        cwd: absCwd,
        env: childEnv(workspaceDbPath(task.workspaceId)),
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
      releaseTask(task.slug);
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
        workspaceId: task.workspaceId,
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

  await startInsert;
  return { kind: 'fired', runId };
}
