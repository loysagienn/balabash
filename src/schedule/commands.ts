// The operator's and the agents' commands over a registered task — one
// implementation for the schedule tool server (src/schedule/tools.ts) and
// the console's endpoints (src/api/api.ts), the way src/projects/mutations.ts
// serves both for projects. Deleting journals schedule.task.cancelled in
// the row's transaction by whoever asked (RegistryAuthor); running fires the
// task exactly as a trigger would and leaves the schedule untouched. A
// refusal is a ScheduleError whose code the api maps to a status and the
// tool to its reply. A command may name the row it means (expectId — the
// console's: the operator confirmed what a card showed): when the slug now
// belongs to another row (the task cancelled and created again under the
// same slug), the command is refused as 'replaced' and touches nothing; a
// tool names only the slug and means whatever row holds it.

import { prisma } from '../db/client.ts';
import { registryMutation } from '../core/registry-events.ts';
import type { RegistryAuthor } from '../core/registry-events.ts';
import type { ScheduledTaskModel } from '../../prisma-generated/models.ts';
import { hasTaskBody, workspaceTaskFile } from './catalog.ts';
import { fireTask } from './engine.ts';
import { taskRecord } from './view.ts';

export type ScheduleErrorCode = 'not_found' | 'replaced' | 'sleeping' | 'no_main_thread';

export class ScheduleError extends Error {
  readonly code: ScheduleErrorCode;

  constructor(code: ScheduleErrorCode, message: string) {
    super(message);
    this.name = 'ScheduleError';
    this.code = code;
  }
}

export async function findTask(userId: string, slug: string): Promise<ScheduledTaskModel | null> {
  return prisma.scheduledTask.findFirst({ where: { slug, userId } });
}

// A code task without a run(ctx) body — neither bundled nor a workspace
// file — sleeps: the heart never arms it and a manual run is refused.
export async function isSleeping(task: ScheduledTaskModel): Promise<boolean> {
  return task.kind === 'code' && !(await hasTaskBody(task.userId, task.slug));
}

export function sleepingText(task: ScheduledTaskModel): string {
  return `task "${task.slug}" is sleeping — no run(ctx) body: neither ${workspaceTaskFile(task.userId, task.slug)} nor a bundled tasks/${task.slug}.ts.`;
}

// The row the command means, when it named one: another row under the
// slug is a replacement, not the task the caller saw.
function assertExpected(task: ScheduledTaskModel, expectId: string | undefined): void {
  if (expectId !== undefined && task.id !== expectId) {
    throw new ScheduleError('replaced', `task "${task.slug}" was replaced since it was read — it is another task now; read it again`);
  }
}

// Deletes the task of the user by slug: the row and its
// schedule.task.cancelled (reason 'cancelled') in one transaction. The
// answer is the row as it was; null when the user has no such task — or
// when it vanished between the lookup and the delete (the heart consuming
// the one-shot journals that end itself; deleteMany keeps the two
// idempotent against each other). With expectId, a slug held by another
// row is refused ('replaced') and that row stays.
export async function deleteTask(userId: string, slug: string, by: RegistryAuthor, expectId?: string): Promise<ScheduledTaskModel | null> {
  const task = await findTask(userId, slug);

  if (!task) {
    return null;
  }

  assertExpected(task, expectId);

  const count = await registryMutation(async (tx, journal) => {
    const deleted = await tx.scheduledTask.deleteMany({ where: { id: task.id } });

    if (deleted.count > 0) {
      await journal('schedule.task.cancelled', { ...taskRecord(task, new Date()), reason: 'cancelled' }, by);
    }

    return deleted.count;
  });

  return count > 0 ? task : null;
}

export type RunOutcome = { kind: 'fired'; task: ScheduledTaskModel; runId: string | null } | { kind: 'already_running'; task: ScheduledTaskModel };

// Runs the task of the user by hand, right now — the action exactly as on
// a trigger fire, the schedule untouched (a one-shot is not consumed, a
// cron task keeps its moment). Refusals: no such task, a sleeping code
// task, a workspace without a main thread to fire into, a slug held by
// another row than expectId names.
export async function runTask(userId: string, slug: string, expectId?: string): Promise<RunOutcome> {
  const task = await findTask(userId, slug);

  if (!task) {
    throw new ScheduleError('not_found', `no task with slug "${slug}" in this workspace`);
  }

  assertExpected(task, expectId);

  // The sleeping-task rule, synchronously: a body-less code task cannot run.
  if (await isSleeping(task)) {
    throw new ScheduleError('sleeping', sleepingText(task));
  }

  const outcome = await fireTask(task, 'manual');

  switch (outcome.kind) {
    case 'fired':
      return { kind: 'fired', task, runId: outcome.runId ?? null };
    case 'already_running':
      return { kind: 'already_running', task };
    case 'no_main_thread':
      throw new ScheduleError('no_main_thread', 'workspace has no main thread to fire into');
    case 'sleeping':
      throw new ScheduleError('sleeping', `task "${slug}" is sleeping — its body is not in the running bundle`);
  }
}
