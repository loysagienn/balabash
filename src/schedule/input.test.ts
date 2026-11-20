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
  it('a reminder: the note kept, a one-shot instant parsed; absent and null fields are one "not given"', () => {
    const input = parseTaskInput({ slug: 'call', name: 'Call', kind: 'note', note: 'Call the electrician', at: '2026-10-12T09:00:00+03:00', cron: null }, NOW);

    assert.deepEqual(input, { slug: 'call', name: 'Call', description: null, kind: 'note', cron: null, at: new Date('2026-10-12T06:00:00Z'), note: 'Call the electrician', code: null, timeoutMs: null, wake: true });
  });

  it('a program: the code kept as written, its limit of time and its flag; without a flag a task wakes', () => {
    const code = '\n  const mail = await call("gmail_search_emails", {});\n  return mail.length || null;\n';
    const input = parseTaskInput({ slug: 'mail', name: 'Mail', kind: 'program', code, cron: '*/10 * * * *', timeoutMs: 90_000, wake: false }, NOW);

    assert.deepEqual(input, { slug: 'mail', name: 'Mail', description: null, kind: 'program', cron: '*/10 * * * *', at: null, note: null, code, timeoutMs: 90_000, wake: false });
    assert.equal(parseTaskInput({ slug: 'mail', name: 'Mail', kind: 'program', code: 'return null' }, NOW).timeoutMs, null);
    assert.equal(parseTaskInput({ slug: 'call', name: 'Call', kind: 'note', note: 'n', wake: null }, NOW).wake, true);
  });

  it('a program is refused without code that parses, and with the fields of another kind', () => {
    const program = { slug: 'x', name: 'n', kind: 'program' };

    assert.match(refusal(program), /^code is required for kind "program"/);
    assert.match(refusal({ ...program, code: '   ' }), /^code is required/);
    assert.match(refusal({ ...program, code: 42 }), /^code must be a string/);
    assert.match(refusal({ ...program, code: 'return 1;\nreturn );' }), /^code does not parse at line 2: SyntaxError: .*body of an async function/);
    assert.match(refusal({ ...program, code: 'return 1', note: 'n' }), /^note applies only to kind "note"/);
    assert.match(refusal({ ...program, code: 'return 1', timeoutMs: 999 }), /^timeoutMs must be an integer between 1000 and 18000000/);
    assert.match(refusal({ ...program, code: 'return 1', wake: 'no' }), /^wake must be a boolean/);
    assert.match(refusal({ slug: 'x', name: 'n', kind: 'note', note: 'n', code: 'return 1' }), /^code applies only to kind "program"/);
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
    assert.match(refusal({ slug: 'x', name: 'n', kind: 'note', note: 'n', cron: '0 9 * * *', at: '2026-10-12T09:00:00Z' }), /^cron and at are mutually exclusive/);
    assert.match(refusal({ slug: 'x', name: 'n', kind: 'note', note: 'n', cron: 'every day' }), /^cron expression "every day" is invalid/);
    assert.match(refusal({ slug: 'x', name: 'n', kind: 'note', note: 'n', at: '2026-10-12T09:00:00' }), /^at must be an ISO 8601 instant with an explicit offset/);
    assert.match(refusal({ slug: 'x', name: 'n', kind: 'note', note: 'n', at: '2026-13-40T09:00:00Z' }), /^at is not a valid ISO 8601 instant/);
    assert.match(refusal({ slug: 'x', name: 42, kind: 'note', note: 'n' }), /^name must be a string/);
  });

  it('accepts only notes and programs', () => {
    for (const kind of ['code', 'command']) {
      assert.match(refusal({ slug: 'x', name: 'n', kind }), /^kind must be "note" or "program"/);
    }
    assert.match(refusal({ slug: 'x', name: 'n', kind: 'note', note: 'hello', timeoutMs: 5000 }), /^timeoutMs applies only to kind "program"/);
  });
});
