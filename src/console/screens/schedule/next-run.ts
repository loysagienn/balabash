// The next moment of a cron task, computed in the browser: the snapshot's
// nextRunAt is the moment read when the row was read or created, and the
// heart writes no event for a fire of a cron task (backlog: "nextRunAt
// after a fire is stale until the next snapshot"), so the screen recomputes
// it from the expression — the same croner the server's heart uses
// (src/schedule/cron.ts), in the schedule's time zone the Settings facts
// name (config.scheduleTimezone over GET /api/settings). Without the zone
// yet, or for an expression croner refuses, the snapshot's moment stands.

import { Cron } from 'croner';

export function nextCronRun(expression: string, from: Date, timezone: string): Date | null {
  try {
    return new Cron(expression, { timezone }).nextRun(from);
  } catch {
    return null;
  }
}

// The next run the row shows: recomputed when the zone is known, else as
// the snapshot read it.
export function nextRunOf(task: { cron: string | null; nextRunAt: Date | null }, now: Date, timezone: string | null): Date | null {
  if (task.cron && timezone) {
    return nextCronRun(task.cron, now, timezone) ?? task.nextRunAt;
  }

  return task.nextRunAt;
}
