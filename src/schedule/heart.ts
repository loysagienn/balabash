// The schedule heart (modeled on runtime/restart.ts's timer half; it lives in
// src/schedule because executing tasks needs the tool layer, which the
// runtime, knowing only core, must not import). One timer, one pass: read the
// registry, arm cron triggers in memory, fire everything due. Time semantics:
// cron is an alarm clock — a missed moment (downtime, a long pass) is
// skipped, the next one counts from "now"; a one-shot `at` means "not before
// T" — a past T fires immediately, and firing consumes the row (failures
// too: no retries). A task without a trigger is invisible to the heart. A
// code task without a body in the running bundle sleeps: never armed, never
// noisy — the boot sweep already journaled the gap loudly.

import { Cron } from 'croner';
import { prisma } from '../db/client.ts';
import { appendEvent } from '../core/append.ts';
import { SYSTEM_EXCEPTION } from '../core/envelope.ts';
import { getMainThread } from '../core/threads.ts';
import { config } from '../config/index.ts';
import type { ScheduledTaskModel } from '../../prisma-generated/models.ts';
import { getTaskBody } from './catalog.ts';
import { fireTask } from './engine.ts';

const POLL_INTERVAL_MS = 5_000;

// The next moment of a cron expression strictly after `from`, in the
// configured timezone; null when the expression yields none.
export function cronNextRun(expression: string, from: Date): Date | null {
  return new Cron(expression, { timezone: config.scheduleTimezone }).nextRun(from);
}

// Validation surface for create_task: throws on a malformed expression.
export function assertValidCron(expression: string): void {
  new Cron(expression, { timezone: config.scheduleTimezone });
}

// Boot sweep — the loud registry-vs-catalog reconciliation: every registered
// code task without a body in this process gets a system.exception into its
// workspace's main thread. This closes the create_task → restart window
// honestly: the task sleeps, and everyone can see why.
async function sweepSleepingTasks(): Promise<void> {
  const rows = await prisma.scheduledTask.findMany({ where: { kind: 'code' }, orderBy: { createdAt: 'asc' } });

  for (const row of rows) {
    if (getTaskBody(row.slug)) {
      continue;
    }

    const main = await getMainThread(row.userId);

    await appendEvent({
      type: SYSTEM_EXCEPTION,
      actor: 'system',
      userId: row.userId,
      threadId: main?.id ?? null,
      payload: {
        scope: 'schedule-boot',
        slug: row.slug,
        error:
          `Scheduled task "${row.slug}" (kind code) has no body in the running bundle — it sleeps until ` +
          `tasks/${row.slug}.ts is added to the static index, the app is rebuilt and restarted.`,
      },
    }).catch(error => {
      console.error(`[schedule] boot sweep failed to journal sleeping task "${row.slug}":`, error);
    });
  }
}

export function startScheduleHeart(): { name: string; stop: () => void } {
  // Armed cron triggers by ROW id (a recreated slug is a new row and re-arms
  // from scratch): the registry keeps only the expression, the next moment is
  // process memory — which is exactly the alarm-clock semantics.
  const armed = new Map<string, Date>();

  const pass = async (): Promise<void> => {
    const rows = await prisma.scheduledTask.findMany();
    const now = new Date();
    const liveIds = new Set(rows.map(row => row.id));

    for (const id of armed.keys()) {
      if (!liveIds.has(id)) {
        armed.delete(id);
      }
    }

    for (const row of rows) {
      // The sleeping-task rule: no body — the heart does not arm and does not
      // complain; the boot sweep already did, once and loudly.
      if (row.kind === 'code' && !getTaskBody(row.slug)) {
        continue;
      }

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

    const outcome = await fireTask(row);

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
    // concurrent cancel_task — zero rows deleted, nothing to fire.
    const { count } = await prisma.scheduledTask.deleteMany({ where: { id: row.id } });

    if (count === 0) {
      return;
    }

    await fireTask(row);
  };

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

  void sweepSleepingTasks();

  console.log('[schedule] heart started');

  return {
    name: 'schedule-heart',
    stop: () => {
      clearInterval(timer);
    },
  };
}
