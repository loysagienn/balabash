import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { atHint, changeTaskForm, cronFacts, cronHint, cwdError, fieldOfTaskFailure, initialTaskForm, instantInZone, parseTimeout, slugFromName, taskRequest, validateTaskForm } from './taskForm.logic.ts';
import type { TaskFormValues } from './taskForm.logic.ts';

const NOW = new Date('2026-10-11T12:00:00Z');
const ZONE = 'Europe/Moscow';

const values = (patch: Partial<TaskFormValues> = {}): TaskFormValues => ({ ...initialTaskForm, name: 'DB backup', slug: 'db-backup', cron: '0 4 * * *', command: 'pg_dump', ...patch });

describe('the slug follows the name', () => {
  it('slugFromName', () => {
    assert.equal(slugFromName('DB backup'), 'db-backup');
    assert.equal(slugFromName('Напомнить про воду'), 'napomnit-pro-vodu');
    assert.equal(slugFromName('2027 plans'), 'plans');
    assert.equal(slugFromName('x'.repeat(70)), 'x'.repeat(64));
  });

  it('changeTaskForm keeps the slug derived until the operator edits it', () => {
    let form = changeTaskForm(initialTaskForm, 'name', 'DB backup');

    assert.equal(form.slug, 'db-backup');
    form = changeTaskForm(form, 'slug', 'backup');
    form = changeTaskForm(form, 'name', 'DB backup nightly');
    assert.equal(form.slug, 'backup');
    assert.equal(changeTaskForm(form, 'reportOnSuccess', true).reportOnSuccess, true);
  });
});

describe('the timeout as a person writes it', () => {
  it('parseTimeout', () => {
    assert.deepEqual(parseTimeout(''), { ms: null });
    assert.deepEqual(parseTimeout('10m'), { ms: 600_000 });
    assert.deepEqual(parseTimeout('1h 30m'), { ms: 5_400_000 });
    assert.deepEqual(parseTimeout('45s'), { ms: 45_000 });
    assert.deepEqual(parseTimeout('2h'), { ms: 7_200_000 });
    assert.deepEqual(parseTimeout(' 5 min '), { ms: 300_000 });
    assert.equal(parseTimeout('90').error, 'Write it with units: 10m, 1h 30m, 45s.');
    assert.equal(parseTimeout('soon').error, 'Write it with units: 10m, 1h 30m, 45s.');
    assert.equal(parseTimeout('0s').error, 'Between 1s and 5h.');
    assert.equal(parseTimeout('6h').error, 'Between 1s and 5h.');
  });
});

describe('a moment typed as the schedule zone’s wall clock', () => {
  it('instantInZone', () => {
    assert.equal(instantInZone('2026-10-13T10:00', ZONE)?.toISOString(), '2026-10-13T07:00:00.000Z');
    assert.equal(instantInZone('2026-10-13T10:00', 'UTC')?.toISOString(), '2026-10-13T10:00:00.000Z');
    // New York: summer time on July 1, standard time on December 1.
    assert.equal(instantInZone('2026-07-01T09:00', 'America/New_York')?.toISOString(), '2026-07-01T13:00:00.000Z');
    assert.equal(instantInZone('2026-12-01T09:00', 'America/New_York')?.toISOString(), '2026-12-01T14:00:00.000Z');
    // The first hour after the spring-forward gap does not exist; the clock lands after it.
    assert.equal(instantInZone('2026-03-08T02:30', 'America/New_York')?.toISOString(), '2026-03-08T07:30:00.000Z');
    assert.equal(instantInZone('2026-10-13', ZONE), null);
    assert.equal(instantInZone('2026-10-13T10:00', 'Mars/Olympus'), null);
  });

  it('atHint', () => {
    assert.equal(atHint(null, NOW, ZONE), 'The clock of Europe/Moscow, the schedule’s time zone.');
    assert.equal(atHint(new Date('2026-10-13T07:00:00Z'), NOW, ZONE), 'Fires Tue, 10:00 (Europe/Moscow), then the task is consumed.');
    assert.equal(atHint(new Date('2026-10-11T07:00:00Z'), NOW, ZONE), 'That moment is past — the task fires at once and is consumed (Europe/Moscow).');
  });
});

describe('the schedule spelled out', () => {
  it('cronFacts and cronHint', () => {
    const daily = cronFacts('0 4 * * *', NOW, ZONE);

    assert.equal(daily.valid, true);
    assert.equal(daily.words, 'daily at 4:00');
    assert.equal(daily.next?.toISOString(), '2026-10-12T01:00:00.000Z');
    assert.equal(cronHint(daily, NOW, ZONE), 'Daily at 4:00 · next run tomorrow, 04:00 (Europe/Moscow)');

    const odd = cronFacts('*/7 * * * *', NOW, ZONE);

    assert.equal(odd.valid, true);
    assert.equal(odd.words, null);
    assert.match(cronHint(odd, NOW, ZONE)!, /^On schedule · next run /);

    assert.deepEqual(cronFacts('every day', NOW, ZONE), { valid: false, words: null, next: null });
    assert.deepEqual(cronFacts('  ', NOW, ZONE), { valid: false, words: null, next: null });
    assert.equal(cronHint(cronFacts('nope', NOW, ZONE), NOW, ZONE), null);
  });
});

describe('the checks before the call', () => {
  it('a command job on a schedule passes; every missing or broken field names itself', () => {
    assert.deepEqual(validateTaskForm(values(), NOW, ZONE), {});
    assert.deepEqual(validateTaskForm(values({ name: ' ', slug: '', cron: '', command: '' }), NOW, ZONE), {
      name: 'A name is required.',
      slug: 'A slug is required.',
      cron: 'A cron expression is required: minute, hour, day of month, month, day of week.',
      command: 'A command is required — it is what the trigger runs (bash -c).',
    });
    assert.deepEqual(validateTaskForm(values({ slug: 'Bad Slug', cron: 'nope', cwd: '../up', timeout: '90' }), NOW, ZONE), {
      slug: 'Lowercase letters, digits, dashes and underscores, starting with a letter.',
      cron: 'Not a cron expression croner reads, or one with no future moment.',
      cwd: 'No “..”, “.” or empty parts in the path.',
      timeout: 'Write it with units: 10m, 1h 30m, 45s.',
    });
    assert.deepEqual(validateTaskForm(values({ name: 'n'.repeat(201), slug: 'a'.repeat(65), description: 'd'.repeat(2001) }), NOW, ZONE), {
      name: 'At most 200 characters.',
      slug: 'At most 64 characters.',
      description: 'At most 2000 characters.',
    });
  });

  it('the trigger and the kind decide which fields count', () => {
    assert.deepEqual(validateTaskForm(values({ when: 'at', at: '' }), NOW, ZONE), { at: 'A moment is required.' });
    assert.deepEqual(validateTaskForm(values({ when: 'at', at: '2026-10-13' }), NOW, ZONE), { at: 'A date and a time of day.' });
    assert.deepEqual(validateTaskForm(values({ when: 'at', at: '2026-10-13T10:00' }), NOW, ZONE), {});
    assert.deepEqual(validateTaskForm(values({ when: 'manual', cron: '' }), NOW, ZONE), {});
    assert.deepEqual(validateTaskForm(values({ kind: 'note', command: '', note: '' }), NOW, ZONE), { note: 'A note is required — it is what the secretary acts on.' });
    assert.deepEqual(validateTaskForm(values({ kind: 'code', command: '', cwd: '/abs', timeout: 'x' }), NOW, ZONE), {}, 'the command fields are not checked for another kind');
  });

  it('cwdError', () => {
    assert.equal(cwdError(''), null);
    assert.equal(cwdError('ops/'), null);
    assert.equal(cwdError('./'), null);
    assert.equal(cwdError('./ops'), null);
    assert.equal(cwdError('/srv'), 'A folder of the file area, relative to its root.');
    assert.equal(cwdError('C:\\x'), 'A folder of the file area, relative to its root.');
    assert.equal(cwdError('a//b'), 'No “..”, “.” or empty parts in the path.');
  });
});

describe('the request the form sends', () => {
  it('a command job: trimmed, the timeout in milliseconds, the folder without "./"', () => {
    assert.deepEqual(taskRequest(values({ name: ' DB backup ', description: ' nightly ', cwd: './ops/', timeout: '10m', reportOnSuccess: true }), ZONE), {
      slug: 'db-backup',
      name: 'DB backup',
      description: 'nightly',
      kind: 'command',
      cron: '0 4 * * *',
      at: null,
      note: null,
      command: 'pg_dump',
      cwd: 'ops',
      timeoutMs: 600_000,
      reportOnSuccess: true,
    });
  });

  it('a reminder once: the moment as an instant of the zone, the command fields null', () => {
    assert.deepEqual(taskRequest(values({ kind: 'note', when: 'at', at: '2026-10-13T10:00', note: ' Call ', command: 'x', cwd: 'y', timeout: '1h', reportOnSuccess: true }), ZONE), {
      slug: 'db-backup',
      name: 'DB backup',
      description: null,
      kind: 'note',
      cron: null,
      at: '2026-10-13T07:00:00.000Z',
      note: 'Call',
      command: null,
      cwd: null,
      timeoutMs: null,
      reportOnSuccess: false,
    });
  });

  it('a code task, manual only', () => {
    const request = taskRequest(values({ kind: 'code', when: 'manual' }), ZONE);

    assert.equal(request.cron, null);
    assert.equal(request.at, null);
    assert.equal(request.command, null);
    assert.equal(request.timeoutMs, null);
  });
});

describe('the field a server refusal belongs to', () => {
  it('fieldOfTaskFailure', () => {
    assert.equal(fieldOfTaskFailure('slug "backup" is already taken — cancel_task it first to recreate'), 'slug');
    assert.equal(fieldOfTaskFailure('slug must match /^[a-z][a-z0-9_-]*$/ and be at most 64 chars'), 'slug');
    assert.equal(fieldOfTaskFailure('name is required'), 'name');
    assert.equal(fieldOfTaskFailure('cron expression "x" is invalid: …'), 'cron');
    assert.equal(fieldOfTaskFailure('at must be an ISO 8601 instant with an explicit offset'), 'at');
    assert.equal(fieldOfTaskFailure('cwd: The cwd must not contain ".."'), 'cwd');
    assert.equal(fieldOfTaskFailure('timeoutMs must be an integer between 1000 and 18000000'), 'timeout');
    assert.equal(fieldOfTaskFailure('note is required for kind "note"'), 'note');
    assert.equal(fieldOfTaskFailure('command is required for kind "command"'), 'command');
    assert.equal(fieldOfTaskFailure('command, cwd, timeoutMs and reportOnSuccess apply only to kind "command"'), 'command');
    assert.equal(fieldOfTaskFailure('kind must be "note", "code" or "command"'), null);
    assert.equal(fieldOfTaskFailure('No such endpoint'), null);
  });
});
