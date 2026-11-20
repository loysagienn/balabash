// Task execution — shared by the heart (due triggers) and the manual run. A
// task is one of two kinds:
//
// - note — a text for the secretary: firing appends a schedule.fired event
//   with the note to the main thread of the workspace, and that event is the
//   whole fact of the firing;
// - program — code run by the catalog's runner as its task in the main thread
//   (programs.ts): every run is a row of the journal of scheduled runs, its
//   value comes to the main thread as schedule.fired, its failure as
//   system.exception.
//
// Every schedule.fired carries the task's flag `wake`: the router starts the
// secretary's turn at once on `true` and leaves the event to wait in the
// main thread on `false` (src/runtime/router.ts). There are no retries.

import type { ScheduledTaskModel } from '../../prisma-generated/models.ts';
import { appendEvent } from '../core/append.ts';
import type { JsonObject } from '../core/contract.ts';
import { SCHEDULE_FIRED } from '../core/envelope.ts';
import { getMainThread } from '../core/threads.ts';
import type { RunTrigger } from './run-record.ts';
import { fireProgramTask } from './programs.ts';

export type FireOutcome =
  // The action ran (a program keeps running detached after the return).
  // Programs have a journal row keyed by runId.
  | { kind: 'fired'; runId?: string }
  // A previous run of the same task is still going — this moment is skipped.
  | { kind: 'already_running' }
  // The workspace has no main thread to address — nothing to fire into.
  | { kind: 'no_main_thread' };

// Executes the task's action exactly as the heart does on a due trigger. The
// schedule itself is untouched here: consuming a one-shot row is the heart's
// business, not the action's.
export async function fireTask(task: ScheduledTaskModel, trigger: RunTrigger): Promise<FireOutcome> {
  const main = await getMainThread(task.workspaceId);

  if (!main) {
    console.warn(`[schedule] task "${task.slug}": workspace ${task.workspaceId} has no main thread; skipping`);

    return { kind: 'no_main_thread' };
  }

  const pushFired = async (payload: JsonObject) => {
    await appendEvent({
      type: SCHEDULE_FIRED,
      actor: 'system',
      workspaceId: task.workspaceId,
      threadId: null,
      targetThreadId: main.id,
      payload: { ...payload, slug: task.slug, name: task.name, wake: task.wake },
    });
  };

  switch (task.kind) {
    case 'note':
      await pushFired({ ...(task.note ? { note: task.note } : {}) });

      return { kind: 'fired' };
    case 'program':
      return fireProgramTask(task, trigger, main, pushFired);
    default:
      throw new Error(`Unsupported scheduled task kind: ${task.kind}`);
  }
}
