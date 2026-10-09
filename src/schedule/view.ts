// The scheduled task as the console sees it: in the snapshot (TaskView) and
// in the schedule.task.* events (TaskRecord — the same fields, dates as ISO
// strings). nextRunAt is the next cron moment after `now` in the schedule
// timezone, or the one-shot `at`; null for a task without a trigger.

import type { ScheduledTaskModel } from '../../prisma-generated/models.ts';
import type { TaskView } from '../api/contract.ts';
import type { TaskRecord } from '../core/event-types.ts';
import { cronNextRun } from './cron.ts';

function safeNextRun(cron: string, now: Date): Date | null {
  try {
    return cronNextRun(cron, now);
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
    command: row.command,
    cwd: row.cwd,
    timeoutMs: row.timeoutMs,
    reportOnSuccess: row.reportOnSuccess,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    nextRunAt: row.cron ? safeNextRun(row.cron, now) : row.at,
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
