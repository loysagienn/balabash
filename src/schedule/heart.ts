// The schedule heart reads the registry once per tick, arms cron triggers
// in memory and fires the tasks that are due. Time semantics:
// cron is an alarm clock — a missed moment (downtime, a long pass) is
// skipped, the next one counts from "now"; a one-shot `at` means "not before
// T" — a past T fires immediately, and firing consumes the row (failures
// too: no retries). A task without a trigger is invisible to the heart.

import { prisma } from '../db/client.ts';
import type { ScheduledTaskModel } from '../../prisma-generated/models.ts';
import { TASK_KINDS } from './input.ts';
import { fireTask } from './engine.ts';
import { cronNextRun } from './cron.ts';
import { registryMutation } from '../core/registry-events.ts';
import { taskRecord } from './view.ts';

const POLL_INTERVAL_MS = 5_000;

export function createSchedulePass(): () => Promise<void> {
  // Armed cron triggers by ROW id (a recreated slug is a new row and re-arms
  // from scratch): the registry keeps only the expression, the next moment is
  // process memory — which is exactly the alarm-clock semantics.
  const armed = new Map<string, Date>();

  const pass = async (): Promise<void> => {
    const rows = await prisma.scheduledTask.findMany({ where: { kind: { in: [...TASK_KINDS] } } });
    const now = new Date();
    const liveIds = new Set(rows.map(row => row.id));

    for (const id of armed.keys()) {
      if (!liveIds.has(id)) {
        armed.delete(id);
      }
    }

    for (const row of rows) {
      if (row.cron) {
        await passCron(row, now);
      } else if (row.at) {
        await passOnce(row, now);
      }
      // No trigger: a stored procedure — run_task territory, not the heart's.
    }
  };

  const passCron = async (row: ScheduledTaskModel, now: Date): Promise<void> => {
    const next = armed.get(row.id);

    if (!next) {
      // Arming (fresh row or fresh process): the next moment counts from
      // "now" — moments before the arming are missed by design.
      const first = cronNextRun(row.cron!, now);

      if (first) {
        armed.set(row.id, first);
      }

      return;
    }

    if (next.getTime() > now.getTime()) {
      return;
    }

    const rearmed = cronNextRun(row.cron!, now);

    if (rearmed) {
      armed.set(row.id, rearmed);
    } else {
      armed.delete(row.id);
    }

    const outcome = await fireTask(row, 'cron');

    if (outcome.kind === 'already_running') {
      console.log(`[schedule] task "${row.slug}": previous run still going — the moment burns`);
    }
  };

  const passOnce = async (row: ScheduledTaskModel, now: Date): Promise<void> => {
    if (row.at!.getTime() > now.getTime()) {
      return;
    }

    // Consume the row BEFORE firing: once means once, even if the action
    // fails (no retries). deleteMany keeps the pass idempotent against a
    // concurrent cancel_task — zero rows deleted, nothing to fire; the
    // consumption is journaled with the delete.
    const count = await registryMutation(async (tx, journal) => {
      const deleted = await tx.scheduledTask.deleteMany({ where: { id: row.id } });

      if (deleted.count > 0) {
        await journal('schedule.task.cancelled', { ...taskRecord(row, now), reason: 'consumed' }, { kind: 'system', workspaceId: row.workspaceId });
      }

      return deleted.count;
    });

    if (count === 0) {
      return;
    }

    await fireTask(row, 'at');
  };

  return pass;
}

export function startScheduleHeart(): { name: string; stop: () => void } {
  const pass = createSchedulePass();
  let ticking = false;

  const timer = setInterval(() => {
    if (ticking) {
      return;
    }

    ticking = true;
    pass()
      .catch(error => {
        console.error('[schedule] pass failed:', error);
      })
      .finally(() => {
        ticking = false;
      });
  }, POLL_INTERVAL_MS);

  console.log('[schedule] heart started');

  return {
    name: 'schedule-heart',
    stop: () => {
      clearInterval(timer);
    },
  };
}
