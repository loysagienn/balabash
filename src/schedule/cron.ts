// Cron arithmetic in the schedule timezone — shared by the heart (the next
// moment to arm), the views of a task (nextRunAt) and create_task's
// validation. Kept apart from the heart so a view never imports the timer.

import { Cron } from 'croner';
import { config } from '../config/index.ts';

// The next moment of a cron expression strictly after `from`, in the
// configured timezone; null when the expression yields none.
export function cronNextRun(expression: string, from: Date): Date | null {
  return new Cron(expression, { timezone: config.scheduleTimezone }).nextRun(from);
}

// Validation surface for create_task: throws on a malformed expression.
export function assertValidCron(expression: string): void {
  new Cron(expression, { timezone: config.scheduleTimezone });
}
