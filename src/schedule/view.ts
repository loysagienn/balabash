// The scheduled task as the console sees it: in the snapshot (TaskView) and
// in the schedule.task.* events (TaskRecord — the same fields, dates as ISO
// strings). nextRunAt is the next cron moment after `now` in the schedule
// timezone, or the one-shot `at`; null for a task without a trigger.

import type { ScheduledTaskModel } from '../../prisma-generated/models.ts';
import type { TaskView } from '../api/contract.ts';
import type { TaskRecord } from '../core/event-types.ts';
import { cronNextRun } from './cron.ts';

export function nextRunAt(row: ScheduledTaskModel, now: Date): Date | null {
  if (!row.cron) {
    return row.at;
  }

  try {
    return cronNextRun(row.cron, now);
  } catch {
    return null;
  }
}

export function taskView(row: ScheduledTaskModel, now: Date): TaskView {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    kind: row.kind,
    cron: row.cron,
    at: row.at,
    note: row.note,
    code: row.code,
    timeoutMs: row.timeoutMs,
    wake: row.wake,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    nextRunAt: nextRunAt(row, now),
  };
}

export function taskRecord(row: ScheduledTaskModel, now: Date): TaskRecord {
  const view = taskView(row, now);

  return {
    ...view,
    at: view.at?.toISOString() ?? null,
    createdAt: view.createdAt.toISOString(),
    nextRunAt: view.nextRunAt?.toISOString() ?? null,
  };
}
