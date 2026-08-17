// Task execution — shared by the heart (due triggers) and the run_task tool
// (manual runs). Executing IS the whole story: runs leave no rows and no
// events of their own; a note task's fact is the schedule.fired append, a
// code task's memory is only what it pushes through ctx.pushEvent. Failures
// of code bodies are journaled as system.exception into the workspace's main
// thread; there are no retries.

import { prisma } from '../db/client.ts';
import type { JsonObject, ToolsApi } from '../core/contract.ts';
import { appendEvent } from '../core/append.ts';
import { SCHEDULE_FIRED, SYSTEM_EXCEPTION } from '../core/envelope.ts';
import { getMainThread } from '../core/threads.ts';
import { callServerTool, getServerToolFunctions, type ToolBundle } from '../capabilities/tool-manager.ts';
import type { ScheduledTaskModel } from '../../prisma-generated/models.ts';
import { getTaskBody } from './catalog.ts';
import type { TaskContext } from './contract.ts';

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

// In-flight code executions by slug: while a run is still going, a new fire
// moment for the same task burns — the heart skips it, run_task reports it.
const running = new Set<string>();

export function isTaskRunning(slug: string): boolean {
  return running.has(slug);
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

export type FireOutcome =
  // The action ran (a code body keeps running detached after the return).
  | { kind: 'fired' }
  // A previous run of the same code task is still going — this moment burns.
  | { kind: 'already_running' }
  // The workspace has no main thread to address — nothing to fire into.
  | { kind: 'no_main_thread' }
  // kind='code' with no body in the current process — the task sleeps.
  | { kind: 'sleeping' };

// Executes the task's action exactly as the heart does on a due trigger. The
// schedule itself is untouched here: consuming a one-shot row is the heart's
// business, not the action's.
export async function fireTask(task: ScheduledTaskModel): Promise<FireOutcome> {
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
