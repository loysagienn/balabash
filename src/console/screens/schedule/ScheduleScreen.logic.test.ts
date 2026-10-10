import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { JobRunView, TaskView } from '../../../api/contract.ts';
import {
  anyRunning,
  createdWords,
  groupRunsByDay,
  kindWords,
  lastRunNote,
  lastRunTime,
  lastRunWords,
  logRunWords,
  noJournalWords,
  orderTasks,
  runDuration,
  runOutcome,
  scheduleDetail,
  scheduleShell,
  taskMatches,
  taskRunWords,
  timeoutWords,
  triggerWords,
  whenLabel,
  whenLabelIn,
  withScheduleFilters,
} from './ScheduleScreen.logic.ts';

const NOW = new Date(2026, 9, 10, 16, 38);
const at = (d: number, h: number, m: number, month = 9) => new Date(2026, month, d, h, m);

const task = (patch: Partial<TaskView> = {}): TaskView => ({
  id: 't1',
  slug: 'db-backup',
  name: 'DB backup',
  description: 'pg_dump to file storage',
  kind: 'command',
  cron: '0 4 * * *',
  at: null,
  note: null,
  command: 'pg_dump -Fc balabash',
  cwd: null,
  timeoutMs: 600_000,
  reportOnSuccess: false,
  createdBy: 'engineer',
  createdAt: at(2, 10, 0),
  nextRunAt: at(11, 4, 0),
  ...patch,
});

const run = (patch: Partial<JobRunView> = {}): JobRunView => ({
  id: 'r1',
  slug: 'db-backup',
  trigger: 'cron',
  status: 'ok',
  exitCode: 0,
  startedAt: at(10, 4, 0),
  finishedAt: at(10, 4, 1),
  durationMs: 41_000,
  stdoutTruncated: false,
  stderrTruncated: false,
  ...patch,
});

describe('the task', () => {
  it('names the kinds as the design does', () => {
    assert.deepEqual(kindWords('note'), { label: 'reminder', icon: 'bell' });
    assert.deepEqual(kindWords('code'), { label: 'code', icon: 'file-code' });
    assert.deepEqual(kindWords('command'), { label: 'command', icon: 'square-terminal' });
    assert.deepEqual(kindWords('other'), { label: 'other', icon: 'calendar-clock' });
  });

  it('spells the trigger', () => {
    assert.deepEqual(triggerWords({ cron: '0 4 * * *', at: null }, NOW), { human: 'daily at 4:00', cron: '0 4 * * *' });
    assert.deepEqual(triggerWords({ cron: '*/15 9-17 * * 1-5', at: null }, NOW), { human: 'on schedule', cron: '*/15 9-17 * * 1-5' });
    assert.deepEqual(triggerWords({ cron: null, at: at(13, 10, 0) }, NOW), { human: 'once · Oct 13, 10:00', cron: null });
    assert.deepEqual(triggerWords({ cron: null, at: null }, NOW), { human: 'manual runs only', cron: null });
  });

  it('says when the next run is', () => {
    assert.equal(whenLabel(at(10, 17, 0), NOW), '17:00');
    assert.equal(whenLabel(at(11, 4, 0), NOW), 'tomorrow, 4:00'.replace('4:00', '04:00'));
    assert.equal(whenLabel(at(12, 10, 0), NOW), 'Mon, 10:00');
    assert.equal(whenLabel(at(17, 10, 0), NOW), 'Oct 17, 10:00');
    assert.equal(whenLabel(at(13, 10, 0, 10), NOW), 'Nov 13, 10:00');
  });

  it('says when the next run is in the schedule’s zone', () => {
    const now = new Date('2026-10-10T20:30:00.000Z');

    // 21:00 UTC is already the next day in Jerusalem (UTC+3) — and tonight in UTC.
    assert.equal(whenLabelIn(new Date('2026-10-10T21:00:00.000Z'), now, 'Asia/Jerusalem'), 'tomorrow, 00:00');
    assert.equal(whenLabelIn(new Date('2026-10-10T21:00:00.000Z'), now, 'UTC'), '21:00');
    assert.equal(whenLabelIn(new Date('2026-10-15T08:30:00.000Z'), now, 'Asia/Jerusalem'), 'Thu, 11:30');
    assert.equal(whenLabelIn(new Date('2026-10-28T05:00:00.000Z'), now, 'Europe/Moscow'), 'Oct 28, 08:00');
    assert.equal(whenLabelIn(new Date('2027-01-05T05:00:00.000Z'), now, 'Europe/Moscow'), 'Jan 5, 2027, 08:00');
    // A zone the browser does not know — the browser's clock.
    assert.equal(whenLabelIn(new Date('2026-10-15T08:30:00.000Z'), now, 'Nowhere/Nowhere'), whenLabel(new Date('2026-10-15T08:30:00.000Z'), now));
  });

  it('spells the timeout and who created the task', () => {
    assert.equal(timeoutWords(null), '10m · default');
    assert.equal(timeoutWords(600_000), '10m');
    assert.equal(timeoutWords(45_000), '45s');
    assert.equal(timeoutWords(90_000), '1m 30s');
    assert.equal(timeoutWords(5_400_000), '1h 30m');
    assert.equal(timeoutWords(18_000_000), '5h');
    assert.equal(createdWords(task(), NOW), 'engineer · Oct 2');
    assert.equal(createdWords(task({ createdBy: null }), NOW), 'Oct 2');
  });

  it('searches the name, description, slug, command and note', () => {
    assert.equal(taskMatches(task(), undefined), true);
    assert.equal(taskMatches(task(), '  '), true);
    assert.equal(taskMatches(task(), 'backup'), true);
    assert.equal(taskMatches(task(), 'STORAGE'), true);
    assert.equal(taskMatches(task(), 'db-back'), true);
    assert.equal(taskMatches(task(), 'pg_dump -fc'), true);
    assert.equal(taskMatches(task({ kind: 'note', command: null, note: 'Call the electrician' }), 'electrician'), true);
    assert.equal(taskMatches(task(), 'mail'), false);
  });

  it('orders the tasks by their next run, manual ones last', () => {
    const ordered = orderTasks([task({ id: 'a', nextRunAt: null }), task({ id: 'b', nextRunAt: at(11, 4, 0) }), task({ id: 'c', nextRunAt: at(10, 17, 0) }), task({ id: 'd', nextRunAt: null })]);

    assert.deepEqual(
      ordered.map(item => item.id),
      ['c', 'b', 'a', 'd'],
    );
  });
});

describe('the runs', () => {
  it('measures a run', () => {
    assert.equal(runDuration(100), '0.1s');
    assert.equal(runDuration(9_900), '9.9s');
    assert.equal(runDuration(41_000), '41s');
    assert.equal(runDuration(192_000), '3:12');
    assert.equal(runDuration(600_000), '10:00');
    assert.equal(runDuration(3_725_000), '1:02:05');
  });

  it('reads the outcome of a run', () => {
    assert.deepEqual(runOutcome({ status: 'ok', exitCode: 0 }), { state: 'done', icon: 'circle-check', exit: 'exit 0', end: null });
    assert.deepEqual(runOutcome({ status: 'failed', exitCode: 127 }), { state: 'err', icon: 'circle-x', exit: 'exit 127', end: 'failed', endState: 'err' });
    assert.deepEqual(runOutcome({ status: 'timeout', exitCode: null }), { state: 'err', icon: 'circle-x', exit: null, end: 'timeout', endState: 'err' });
    assert.deepEqual(runOutcome({ status: 'spawn_error', exitCode: null }), { state: 'err', icon: 'circle-x', exit: null, end: 'didn’t start', endState: 'err' });
    assert.deepEqual(runOutcome({ status: 'aborted', exitCode: null }), { state: 'off', icon: 'circle-slash', exit: null, end: 'interrupted', endState: 'off' });
    assert.deepEqual(runOutcome({ status: 'running', exitCode: null }), { state: 'run', icon: 'loader-circle', exit: null, end: 'running', endState: 'run' });
  });

  it('words a run among its task’s runs', () => {
    assert.deepEqual(taskRunWords(run({ startedAt: at(8, 4, 0) }), NOW), { state: 'done', icon: 'circle-check', tool: 'Oct 8, 04:00', arg: 'scheduled · exit 0', end: '41s', endState: undefined });
    assert.deepEqual(taskRunWords(run({ status: 'spawn_error', exitCode: 127, durationMs: 100, trigger: 'cron' }), NOW), {
      state: 'err',
      icon: 'circle-x',
      tool: '04:00',
      arg: 'scheduled · exit 127',
      end: 'didn’t start · 0.1s',
      endState: 'err',
    });
    assert.deepEqual(taskRunWords(run({ status: 'timeout', exitCode: null, durationMs: 600_000, trigger: 'manual' }), NOW).end, 'timeout · 10:00');
    // A run still going is measured to now; a journal without a duration, to its end.
    assert.deepEqual(taskRunWords(run({ status: 'running', exitCode: null, finishedAt: null, durationMs: null, startedAt: at(10, 16, 30) }), NOW), {
      state: 'run',
      icon: 'loader-circle',
      tool: '16:30',
      arg: 'scheduled',
      end: 'running · 8:00',
      endState: 'run',
    });
    assert.equal(taskRunWords(run({ status: 'aborted', exitCode: null, durationMs: null, startedAt: at(5, 4, 0), finishedAt: at(5, 4, 3), trigger: 'at' }), NOW).end, 'interrupted · 3:00');
    assert.equal(taskRunWords(run({ trigger: 'at' }), NOW).arg, 'one-off · exit 0');
  });

  it('words a run in the log by its task', () => {
    assert.deepEqual(logRunWords(run({ status: 'failed', exitCode: 1, durationMs: 3_000, startedAt: at(10, 16, 30) }), 'Mail sync', NOW), {
      state: 'err',
      icon: 'circle-x',
      tool: 'Mail sync',
      arg: 'scheduled · exit 1',
      end: '16:30 · failed · 3.0s',
      endState: 'err',
    });
    assert.equal(logRunWords(run({ startedAt: at(10, 12, 0), durationMs: 1_000 }), 'Disk check', NOW).end, '12:00 · 1.0s');
  });

  it('words the last run of a row', () => {
    assert.equal(lastRunTime(at(10, 12, 0), NOW), '12:00');
    assert.equal(lastRunTime(at(9, 23, 0), NOW), 'yesterday 23:00');
    assert.equal(lastRunTime(at(5, 10, 0), NOW), 'Mon 10:00');
    assert.equal(lastRunTime(at(1, 10, 0), NOW), 'Oct 1, 10:00');
    assert.deepEqual(lastRunWords(run({ startedAt: at(10, 12, 0) }), NOW), { state: 'done', label: '12:00' });
    assert.deepEqual(lastRunWords(run({ status: 'failed', exitCode: 1, startedAt: at(10, 16, 30) }), NOW), { state: 'err', label: 'error · 16:30' });
    assert.deepEqual(lastRunWords(run({ status: 'spawn_error', exitCode: 127 }), NOW), { state: 'err', label: 'didn’t start · 04:00' });
    assert.deepEqual(lastRunWords(run({ status: 'timeout', exitCode: null }), NOW), { state: 'err', label: 'timeout · 04:00' });
    assert.deepEqual(lastRunWords(run({ status: 'aborted', exitCode: null }), NOW), { state: 'off', label: 'interrupted · 04:00' });
    assert.deepEqual(lastRunWords(run({ status: 'running', exitCode: null }), NOW), { state: 'run', label: 'running' });
  });

  it('writes the banner of a last run gone wrong', () => {
    assert.equal(lastRunNote(run(), NOW), null);
    assert.equal(lastRunNote(run({ status: 'running' }), NOW), null);
    assert.equal(lastRunNote(run({ status: 'failed', exitCode: 1 }), NOW), 'The last run failed with exit code 1 · 04:00. A notification went to the bell; the output is below.');
    assert.equal(lastRunNote(run({ status: 'timeout', exitCode: null, durationMs: 600_000, startedAt: at(8, 4, 0) }), NOW), 'The last run timed out after 10:00 · Oct 8, 04:00. The process group was killed; a notification went to the bell.');
    assert.match(lastRunNote(run({ status: 'spawn_error' }), NOW) ?? '', /didn’t start/);
    assert.match(lastRunNote(run({ status: 'aborted' }), NOW) ?? '', /interrupted by a restart/);
  });

  it('groups the log by day and sees a run still going', () => {
    const days = groupRunsByDay([run({ id: 'a', startedAt: at(10, 16, 30) }), run({ id: 'b', startedAt: at(10, 9, 0) }), run({ id: 'c', startedAt: at(9, 23, 0) })], NOW);

    assert.deepEqual(
      days.map(day => [day.label, day.runs.map(item => item.id)]),
      [
        ['Today, October 10', ['a', 'b']],
        ['Yesterday, October 9', ['c']],
      ],
    );
    assert.equal(anyRunning([run(), run({ status: 'running' })]), true);
    assert.equal(anyRunning([run()]), false);
    assert.equal(anyRunning([]), false);
  });

  it('says what a task of a kind leaves behind', () => {
    assert.match(noJournalWords('note') ?? '', /reminder leaves no run log/);
    assert.match(noJournalWords('code') ?? '', /code task leaves no run log/);
    assert.equal(noJournalWords('command'), null);
  });
});

describe('the screen', () => {
  it('builds the next route of a filter change', () => {
    assert.deepEqual(withScheduleFilters({ key: 'schedule' }, { q: 'back' }), { key: 'schedule', q: 'back' });
    assert.deepEqual(withScheduleFilters({ key: 'schedule', q: 'back' }, { q: '' }), { key: 'schedule' });
    assert.deepEqual(withScheduleFilters({ key: 'schedule', q: 'back' }, { tab: 'log' }), { key: 'schedule', tab: 'log' });
    assert.deepEqual(withScheduleFilters({ key: 'schedule', tab: 'log', task: 'db-backup' }, { tab: undefined }), { key: 'schedule' });
    assert.deepEqual(withScheduleFilters({ key: 'schedule', slug: 'db-backup' }, { slug: undefined }), { key: 'schedule' });
  });

  it('shapes the shell and the details panel', () => {
    assert.deepEqual(scheduleShell({ key: 'schedule' }, null), { title: 'Schedule', detail: false });
    assert.deepEqual(scheduleShell({ key: 'schedule', slug: 'db-backup' }, task()), { title: 'Schedule', titleNarrow: 'DB backup', back: { key: 'schedule' }, backNarrow: true, detail: true });
    assert.equal(scheduleShell({ key: 'schedule', slug: 'gone' }, null).titleNarrow, 'gone');
    assert.equal(scheduleDetail(undefined, false, 'ready'), 'pick');
    assert.equal(scheduleDetail('db-backup', false, 'loading'), 'loading');
    assert.equal(scheduleDetail('db-backup', true, 'ready'), 'task');
    assert.equal(scheduleDetail('db-backup', false, 'ready'), 'unknown');
  });
});
