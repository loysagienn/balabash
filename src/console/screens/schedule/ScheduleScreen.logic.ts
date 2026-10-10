// The words and rules of the Schedule screen: the kinds of a task, its
// schedule spelled out and its next run, the search, the shell of the split
// view (the selected task is a detail screen on the phone), the words of a
// run — in a task's runs, in the log, as the last run of a row — and of
// the task's own facts (timeout, who created it). Pure, tested.

import type { JobRunStatus, JobRunView, JobTrigger, TaskView } from '../../../api/contract.ts';
import type { IconName } from '../../ui/Icon/Icon.tsx';
import type { StateName } from '../../ui/atoms/state.ts';
import type { XpState } from '../../ui/Xp/Xp.tsx';
import type { AppRoute, ScheduleRoute } from '../../lib/router/routes.ts';
import type { SnapshotStage } from '../../store/stream/selectors.ts';
import { dateTimeLabel, dayLabel, shortDate, timeOfDay } from '../../lib/format/index.ts';
import { cronWords } from './cron-words.ts';

// ---------------------------------------------------------------------------
// The task

export type KindWords = { label: string; icon: IconName };

// The kinds as the registry names them — the design calls a note a reminder.
export function kindWords(kind: string): KindWords {
  switch (kind) {
    case 'note':
      return { label: 'reminder', icon: 'bell' };
    case 'code':
      return { label: 'code', icon: 'file-code' };
    case 'command':
      return { label: 'command', icon: 'square-terminal' };
    default:
      return { label: kind, icon: 'calendar-clock' };
  }
}

export type TriggerWords = { human: string; cron: string | null };

// "daily at 4:00" with the expression beside it; a shape the words do not
// cover — "on schedule" and the expression; a one-off — "once · Oct 13,
// 10:00"; neither — manual runs only.
export function triggerWords(task: Pick<TaskView, 'cron' | 'at'>, now: Date): TriggerWords {
  if (task.cron) {
    return { human: cronWords(task.cron) ?? 'on schedule', cron: task.cron };
  }

  if (task.at) {
    return { human: `once · ${dateTimeLabel(task.at, now)}`, cron: null };
  }

  return { human: 'manual runs only', cron: null };
}

const DAY = 86_400_000;

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

// "17:00" today, "tomorrow, 4:00", "Mon, 10:00" within the week, then
// "Oct 13, 10:00" — the next run in the row's time column.
export function whenLabel(date: Date, now: Date): string {
  const days = Math.round((startOfDay(date) - startOfDay(now)) / DAY);

  if (days === 0) {
    return timeOfDay(date);
  }

  if (days === 1) {
    return `tomorrow, ${timeOfDay(date)}`;
  }

  if (days > 1 && days < 7) {
    return `${date.toLocaleDateString('en-US', { weekday: 'short' })}, ${timeOfDay(date)}`;
  }

  return `${shortDate(date, now)}, ${timeOfDay(date)}`;
}

// The same, told in a named time zone (the schedule's): the day and the
// clock are the zone's, so the words beside the zone's name are true. A
// zone the browser does not know falls back to the browser's clock.
export function whenLabelIn(date: Date, now: Date, timeZone: string): string {
  let dayOf: (d: Date) => string;
  let clock: (d: Date) => string;
  let weekday: (d: Date) => string;
  let monthDay: (d: Date) => string;

  try {
    const day = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    const time = new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const week = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' });
    const short = new Intl.DateTimeFormat('en-US', { timeZone, month: 'short', day: 'numeric' });
    const year = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric' });

    dayOf = d => day.format(d);
    clock = d => time.format(d);
    weekday = d => week.format(d);
    monthDay = d => (year.format(d) === year.format(now) ? short.format(d) : `${short.format(d)}, ${year.format(d)}`);
  } catch {
    return whenLabel(date, now);
  }

  const days = Math.round((Date.parse(dayOf(date)) - Date.parse(dayOf(now))) / DAY);

  if (days === 0) {
    return clock(date);
  }

  if (days === 1) {
    return `tomorrow, ${clock(date)}`;
  }

  if (days > 1 && days < 7) {
    return `${weekday(date)}, ${clock(date)}`;
  }

  return `${monthDay(date)}, ${clock(date)}`;
}

// "10m", "1h 30m", "45s" — a kill timeout; the default named as such.
export function timeoutWords(timeoutMs: number | null): string {
  const ms = timeoutMs ?? 600_000;
  const seconds = Math.round(ms / 1000);
  let words: string;

  if (seconds < 60) {
    words = `${seconds}s`;
  } else if (seconds % 3600 === 0) {
    words = `${seconds / 3600}h`;
  } else if (seconds >= 3600) {
    words = `${Math.floor(seconds / 3600)}h ${Math.round((seconds % 3600) / 60)}m`;
  } else if (seconds % 60 === 0) {
    words = `${seconds / 60}m`;
  } else {
    words = `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  }

  return timeoutMs === null ? `${words} · default` : words;
}

// "engineer · Oct 2" — who registered the task and when; without an agent
// (a task written before the column) — the date alone.
export function createdWords(task: Pick<TaskView, 'createdBy' | 'createdAt'>, now: Date): string {
  const when = shortDate(task.createdAt, now);

  return task.createdBy ? `${task.createdBy} · ${when}` : when;
}

// The search looks through the name, the description, the slug, the
// command and the note, case-insensitive.
export function taskMatches(task: Pick<TaskView, 'name' | 'description' | 'slug' | 'command' | 'note'>, q: string | undefined): boolean {
  const needle = q?.trim().toLowerCase();

  if (!needle) {
    return true;
  }

  return [task.name, task.description, task.slug, task.command, task.note].some(text => text !== null && text.toLowerCase().includes(needle));
}

// The tasks in the order of the list: the ones with a next run first, the
// soonest on top; the rest (manual runs only) after, as registered.
export function orderTasks<T extends { nextRunAt: Date | null }>(tasks: T[]): T[] {
  return [...tasks].sort((a, b) => {
    if (a.nextRunAt && b.nextRunAt) {
      return a.nextRunAt.getTime() - b.nextRunAt.getTime();
    }

    return a.nextRunAt ? -1 : b.nextRunAt ? 1 : 0;
  });
}

// ---------------------------------------------------------------------------
// The runs

export type TriggerName = 'scheduled' | 'one-off' | 'manual';

export function triggerName(trigger: JobTrigger | string): TriggerName | string {
  switch (trigger) {
    case 'cron':
      return 'scheduled';
    case 'at':
      return 'one-off';
    case 'manual':
      return 'manual';
    default:
      return trigger;
  }
}

// "0.1s", "41s", "3:12", "1:02:05" — the length of a run.
export function runDuration(ms: number): string {
  const total = Math.max(0, ms);

  if (total < 10_000) {
    return `${(total / 1000).toFixed(1)}s`;
  }

  const seconds = Math.round(total / 1000);

  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const rest = String(seconds % 60).padStart(2, '0');

  if (minutes < 60) {
    return `${minutes}:${rest}`;
  }

  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${rest}`;
}

// How long a run took, or has been going: the journaled duration, else
// the span of its start and end, else the span to now.
export function runLength(run: Pick<JobRunView, 'startedAt' | 'finishedAt' | 'durationMs'>, now: Date): number {
  if (run.durationMs !== null) {
    return run.durationMs;
  }

  return (run.finishedAt ?? now).getTime() - run.startedAt.getTime();
}

export type RunOutcome = {
  state: XpState;
  icon: IconName;
  // "exit 0", "exit 127" — the exit code when the run ended by itself.
  exit: string | null;
  // "didn’t start", "timeout", "interrupted", "running" — what ended the
  // run otherwise; null for a plain success or failure.
  end: string | null;
  endState?: 'run' | 'err' | 'off';
};

// The outcome of a run in the words of the design's rows: a success is a
// check with its exit code, a failure a cross with its code, a timeout the
// kill with the length it was allowed, a spawn error "didn’t start", a run
// killed by a restart "interrupted", a run still going "running".
export function runOutcome(run: Pick<JobRunView, 'status' | 'exitCode'>): RunOutcome {
  const exit = run.exitCode !== null ? `exit ${run.exitCode}` : null;

  switch (run.status as JobRunStatus) {
    case 'ok':
      return { state: 'done', icon: 'circle-check', exit: exit ?? 'exit 0', end: null };
    case 'failed':
      return { state: 'err', icon: 'circle-x', exit, end: 'failed', endState: 'err' };
    case 'timeout':
      return { state: 'err', icon: 'circle-x', exit, end: 'timeout', endState: 'err' };
    case 'spawn_error':
      return { state: 'err', icon: 'circle-x', exit, end: 'didn’t start', endState: 'err' };
    case 'aborted':
      return { state: 'off', icon: 'circle-slash', exit, end: 'interrupted', endState: 'off' };
    case 'running':
      return { state: 'run', icon: 'loader-circle', exit: null, end: 'running', endState: 'run' };
    default:
      return { state: 'off', icon: 'circle-slash', exit, end: run.status, endState: 'off' };
  }
}

export type RunRowWords = { state: XpState; icon: IconName; tool: string; arg: string; end: string; endState?: 'run' | 'err' | 'off' };

// A run among its task's runs: when it started, how it was triggered and
// how it ended, how long it took — "Oct 8, 04:00 · scheduled · exit 127 ·
// didn’t start · 0.1s".
export function taskRunWords(run: JobRunView, now: Date): RunRowWords {
  const outcome = runOutcome(run);
  const length = runDuration(runLength(run, now));

  return {
    state: outcome.state,
    icon: outcome.icon,
    tool: dateTimeLabel(run.startedAt, now),
    arg: [triggerName(run.trigger), outcome.exit].filter((part): part is string => part !== null).join(' · '),
    end: outcome.end ? `${outcome.end} · ${length}` : length,
    endState: outcome.endState,
  };
}

// A run in the log of every task: the task's name first, then the trigger
// and the exit code; on the right the time of day and the length.
export function logRunWords(run: JobRunView, name: string, now: Date): RunRowWords {
  const outcome = runOutcome(run);
  const length = runDuration(runLength(run, now));

  return {
    state: outcome.state,
    icon: outcome.icon,
    tool: name,
    arg: [triggerName(run.trigger), outcome.exit].filter((part): part is string => part !== null).join(' · '),
    end: `${timeOfDay(run.startedAt)} · ${outcome.end ? `${outcome.end} · ${length}` : length}`,
    endState: outcome.endState,
  };
}

// "12:00" today, "yesterday 23:00", "Mon 10:00" within the week, then
// "Oct 6, 18:12" — when the last run was.
export function lastRunTime(date: Date, now: Date): string {
  const days = Math.round((startOfDay(now) - startOfDay(date)) / DAY);

  if (days === 0) {
    return timeOfDay(date);
  }

  if (days === 1) {
    return `yesterday ${timeOfDay(date)}`;
  }

  if (days > 1 && days < 7) {
    return `${date.toLocaleDateString('en-US', { weekday: 'short' })} ${timeOfDay(date)}`;
  }

  return `${shortDate(date, now)}, ${timeOfDay(date)}`;
}

export type LastRunWords = { state: StateName; label: string };

// The last run in a task's row: a success by its time, anything else by
// what happened — "error · 16:30", "didn’t start · 04:00", "running".
export function lastRunWords(run: JobRunView, now: Date): LastRunWords {
  const outcome = runOutcome(run);
  const time = lastRunTime(run.startedAt, now);

  switch (run.status as JobRunStatus) {
    case 'ok':
      return { state: 'done', label: time };
    case 'running':
      return { state: 'run', label: 'running' };
    case 'failed':
      return { state: 'err', label: `error · ${time}` };
    default:
      return { state: outcome.state === 'err' ? 'err' : 'off', label: `${outcome.end ?? run.status} · ${time}` };
  }
}

// The banner over a task whose last run went wrong, with where to look.
export function lastRunNote(run: JobRunView, now: Date): string | null {
  const when = dateTimeLabel(run.startedAt, now);

  switch (run.status as JobRunStatus) {
    case 'failed':
      return `The last run failed${run.exitCode !== null ? ` with exit code ${run.exitCode}` : ''} · ${when}. A notification went to the bell; the output is below.`;
    case 'timeout':
      return `The last run timed out after ${runDuration(runLength(run, now))} · ${when}. The process group was killed; a notification went to the bell.`;
    case 'spawn_error':
      return `The last run didn’t start · ${when}. The error is in its output below; a notification went to the bell.`;
    case 'aborted':
      return `The last run was interrupted by a restart · ${when}. It was not retried.`;
    default:
      return null;
  }
}

// The runs of the log under day dividers, newest first.
export type RunDay = { key: string; label: string; runs: JobRunView[] };

export function groupRunsByDay(runs: JobRunView[], now: Date): RunDay[] {
  const days: RunDay[] = [];

  for (const run of runs) {
    const key = String(startOfDay(run.startedAt));
    const last = days[days.length - 1];

    if (last && last.key === key) {
      last.runs.push(run);
    } else {
      days.push({ key, label: dayLabel(run.startedAt, now), runs: [run] });
    }
  }

  return days;
}

// Whether a list of runs holds one still going — the screen polls then.
export function anyRunning(runs: Pick<JobRunView, 'status'>[]): boolean {
  return runs.some(run => run.status === 'running');
}

// What a task of a kind leaves behind: only a command job has a journal.
export function noJournalWords(kind: string): string | null {
  switch (kind) {
    case 'note':
      return 'A reminder leaves no run log: when it fires, the note lands in the main thread as a message to the secretary.';
    case 'code':
      return 'A code task leaves no run log: it reports through the events it pushes to the main thread; a failure shows in the bell.';
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// The screen

export type ScheduleFilterPatch = Partial<Omit<ScheduleRoute, 'key'>>;

// The next route of a change: an undefined or empty value drops the key,
// so the URL stays canonical; the search belongs to the tasks tab, the
// task filter to the log.
export function withScheduleFilters(route: ScheduleRoute, patch: ScheduleFilterPatch): ScheduleRoute {
  const next: ScheduleRoute = { ...route, ...patch };

  for (const key of ['slug', 'tab', 'task', 'q'] as const) {
    if (next[key] === undefined || next[key] === '') {
      delete next[key];
    }
  }

  if (next.tab === 'log') {
    delete next.q;
  } else {
    delete next.task;
  }

  return next;
}

export type ScheduleShell = { title: string; titleNarrow?: string; back?: AppRoute; backNarrow?: boolean; detail: boolean };

// The shell of the split view: a selected task is a detail screen on the
// phone, titled by its name, with "Back" to the list — and a panel beside
// the list when wide.
export function scheduleShell(route: ScheduleRoute, task: Pick<TaskView, 'name'> | null): ScheduleShell {
  if (!route.slug) {
    return { title: 'Schedule', detail: false };
  }

  return { title: 'Schedule', titleNarrow: task?.name ?? route.slug, back: { key: 'schedule' }, backNarrow: true, detail: true };
}

export type ScheduleDetail = 'pick' | 'task' | 'unknown' | 'loading';

// What the details panel shows — the panel is the whole screen on the
// phone when a task is named, so the first snapshot in flight shows there
// too. A slug the ready list does not know is "unknown".
export function scheduleDetail(slug: string | undefined, found: boolean, stage: SnapshotStage): ScheduleDetail {
  if (!slug) {
    return 'pick';
  }

  if (stage !== 'ready') {
    return 'loading';
  }

  return found ? 'task' : 'unknown';
}
