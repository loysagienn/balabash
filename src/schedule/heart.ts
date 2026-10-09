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

import { prisma } from '../db/client.ts';
import { appendEvent } from '../core/append.ts';
import { SYSTEM_EXCEPTION } from '../core/envelope.ts';
import { getMainThread } from '../core/threads.ts';
import type { ScheduledTaskModel } from '../../prisma-generated/models.ts';
import { hasTaskBody, workspaceTaskFile } from './catalog.ts';
import { fireTask, sweepAbortedJobRuns } from './engine.ts';
import { cronNextRun } from './cron.ts';
import { registryMutation } from '../core/registry-events.ts';
import { taskRecord } from './view.ts';

export { assertValidCron, cronNextRun } from './cron.ts';

const POLL_INTERVAL_MS = 5_000;

// Boot sweep — the loud registry-vs-catalog reconciliation: every registered
// code task without a body (neither bundled nor a workspace file) gets a
// system.exception into its workspace's main thread. This closes the create_task → restart window
// honestly: the task sleeps, and everyone can see why.
async function sweepSleepingTasks(): Promise<void> {
  const rows = await prisma.scheduledTask.findMany({ where: { kind: 'code' }, orderBy: { createdAt: 'asc' } });

  for (const row of rows) {
    if (await hasTaskBody(row.userId, row.slug)) {
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
          `Scheduled task "${row.slug}" (kind code) has no body — it sleeps until ${workspaceTaskFile(row.userId, row.slug)} ` +
          `exists (live at the next fire) or tasks/${row.slug}.ts is added to the repository index, built and restarted.`,
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
      if (row.kind === 'code' && !(await hasTaskBody(row.userId, row.slug))) {
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
        await journal('schedule.task.cancelled', { ...taskRecord(row, now), reason: 'consumed' }, { kind: 'system', userId: row.userId });
      }

      return deleted.count;
    });

    if (count === 0) {
      return;
    }

    await fireTask(row, 'at');
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
  // Workspace jobs do not survive a restart: rows left 'running' by the
  // previous process are settled as 'aborted'.
  void sweepAbortedJobRuns();

  console.log('[schedule] heart started');

  return {
    name: 'schedule-heart',
    stop: () => {
      clearInterval(timer);
    },
  };
}
