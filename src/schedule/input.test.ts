// The rule of a new task's input (input.ts), pure: what passes becomes the
// row, what is refused names its field first.
//
// Run: npm test  (node:test, native type stripping — no build needed).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ScheduleError } from './errors.ts';
import { parseTaskInput } from './input.ts';

const NOW = new Date('2026-10-11T12:00:00Z');

function refusal(raw: Record<string, unknown>): string {
  try {
    parseTaskInput(raw, NOW);
  } catch (error) {
    assert.ok(error instanceof ScheduleError, String(error));
    assert.equal(error.code, 'bad_request');

    return error.message;
  }

  throw new Error('passed');
}

describe('parseTaskInput', () => {
  it('a command job: the fields trimmed, the folder normalized, the note dropped', () => {
    const input = parseTaskInput({ slug: ' backup ', name: ' DB backup ', description: '  ', kind: 'command', cron: '0 4 * * *', command: ' pg_dump ', cwd: './ops', timeoutMs: 600_000, reportOnSuccess: true, note: 'ignored' }, NOW);

    assert.deepEqual(input, { slug: 'backup', name: 'DB backup', description: null, kind: 'command', cron: '0 4 * * *', at: null, note: null, command: 'pg_dump', cwd: 'ops', timeoutMs: 600_000, reportOnSuccess: true });
  });

  it('a reminder: the note kept, a one-shot instant parsed; absent and null fields are one "not given"', () => {
    const input = parseTaskInput({ slug: 'call', name: 'Call', kind: 'note', note: 'Call the electrician', at: '2026-10-12T09:00:00+03:00', cron: null, command: null }, NOW);

    assert.deepEqual(input, { slug: 'call', name: 'Call', description: null, kind: 'note', cron: null, at: new Date('2026-10-12T06:00:00Z'), note: 'Call the electrician', command: null, cwd: null, timeoutMs: null, reportOnSuccess: false });
  });

  it('a code task without a trigger — a stored procedure', () => {
    const input = parseTaskInput({ slug: 'digest', name: 'Digest', kind: 'code', description: 'd' }, NOW);

    assert.deepEqual(input, { slug: 'digest', name: 'Digest', description: 'd', kind: 'code', cron: null, at: null, note: null, command: null, cwd: null, timeoutMs: null, reportOnSuccess: false });
  });

  it('refusals name the field first', () => {
    assert.match(refusal({ name: 'x', kind: 'note', note: 'n' }), /^slug is required/);
    assert.match(refusal({ slug: 'Bad Slug', name: 'x', kind: 'note', note: 'n' }), /^slug must match/);
    assert.match(refusal({ slug: 'a'.repeat(65), name: 'x', kind: 'note', note: 'n' }), /^slug must match .* at most 64/);
    assert.match(refusal({ slug: 'x', name: '  ', kind: 'note', note: 'n' }), /^name is required/);
    assert.match(refusal({ slug: 'x', name: 'n'.repeat(201), kind: 'note', note: 'n' }), /^name must be at most 200/);
    assert.match(refusal({ slug: 'x', name: 'n', kind: 'note', note: 'n', description: 'd'.repeat(2001) }), /^description must be at most 2000/);
    assert.match(refusal({ slug: 'x', name: 'n', kind: 'job' }), /^kind must be/);
    assert.match(refusal({ slug: 'x', name: 'n', kind: 'note' }), /^note is required for kind "note"/);
    assert.match(refusal({ slug: 'x', name: 'n', kind: 'command' }), /^command is required/);
    assert.match(refusal({ slug: 'x', name: 'n', kind: 'command', command: 'true', cwd: '../out' }), /^cwd: /);
    assert.match(refusal({ slug: 'x', name: 'n', kind: 'command', command: 'true', cwd: '/abs' }), /^cwd: /);
    assert.match(refusal({ slug: 'x', name: 'n', kind: 'command', command: 'true', timeoutMs: 500 }), /^timeoutMs must be an integer between 1000 and 18000000/);
    assert.match(refusal({ slug: 'x', name: 'n', kind: 'command', command: 'true', timeoutMs: 1.5 }), /^timeoutMs must be an integer/);
    assert.match(refusal({ slug: 'x', name: 'n', kind: 'command', command: 'true', timeoutMs: '5000' }), /^timeoutMs must be a number/);
    assert.match(refusal({ slug: 'x', name: 'n', kind: 'command', command: 'true', reportOnSuccess: 'yes' }), /^reportOnSuccess must be a boolean/);
    assert.match(refusal({ slug: 'x', name: 'n', kind: 'note', note: 'n', cron: '0 9 * * *', at: '2026-10-12T09:00:00Z' }), /^cron and at are mutually exclusive/);
    assert.match(refusal({ slug: 'x', name: 'n', kind: 'note', note: 'n', cron: 'every day' }), /^cron expression "every day" is invalid/);
    assert.match(refusal({ slug: 'x', name: 'n', kind: 'note', note: 'n', at: '2026-10-12T09:00:00' }), /^at must be an ISO 8601 instant with an explicit offset/);
    assert.match(refusal({ slug: 'x', name: 'n', kind: 'note', note: 'n', at: '2026-13-40T09:00:00Z' }), /^at is not a valid ISO 8601 instant/);
    assert.match(refusal({ slug: 'x', name: 42, kind: 'note', note: 'n' }), /^name must be a string/);
  });

  it('the command fields of another kind are a confusion, not ignored', () => {
    assert.match(refusal({ slug: 'x', name: 'n', kind: 'note', note: 'n', command: 'true' }), /apply only to kind "command" — null them for kind "note"/);
    assert.match(refusal({ slug: 'x', name: 'n', kind: 'code', timeoutMs: 5_000 }), /apply only to kind "command"/);
    assert.match(refusal({ slug: 'x', name: 'n', kind: 'code', reportOnSuccess: true }), /apply only to kind "command"/);
    // false and null are "not given".
    assert.equal(parseTaskInput({ slug: 'x', name: 'n', kind: 'code', reportOnSuccess: false, timeoutMs: null, cwd: '' }, NOW).kind, 'code');
  });
});
