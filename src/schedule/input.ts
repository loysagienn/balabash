// The input of a new scheduled task, checked — one rule for every door of
// the registry: the capability `schedule_create_task` (src/tree/schedule.ts),
// the create_task tool of the agents (src/schedule/tools.ts) and the
// console's POST /api/schedule/tasks (src/api/api.ts). Pure (no database): a
// TaskInput is what the registry row will hold; a refusal is a
// ScheduleError 'bad_request' whose message starts with the field at fault,
// so a form can put it under that field. The rules: the slug's shape and
// cap, a non-empty name, at most one trigger (a valid cron expression that
// yields a future moment, or an ISO 8601 instant with an explicit offset —
// a naive timestamp is ambiguous), a note for kind "note", code that parses
// for kind "program" with its limit of time in range; a field of another
// kind is a confusion, not ignored. A wrong type is a refusal.

import { assertValidCron, cronNextRun } from './cron.ts';
import { ScheduleError } from './errors.ts';
import { programSyntaxProblem } from '../catalog/index.ts';
import { PROGRAM_TIMEOUT_DEFAULT_MS, PROGRAM_TIMEOUT_MAX_MS, PROGRAM_TIMEOUT_MIN_MS } from './programs.ts';

export const SLUG_PATTERN = /^[a-z][a-z0-9_-]*$/;
export const SLUG_MAX_LENGTH = 64;
// A name is a row's title, a description a line under it: the caps only
// keep a runaway body out (the project registry's caps).
export const NAME_MAX_LENGTH = 200;
export const DESCRIPTION_MAX_LENGTH = 2_000;

export type TaskKind = 'note' | 'program';

// The row to write: the trigger as the registry stores it (`at` an
// instant), the note kept for kind "note" only, the code for kind "program"
// only.
export type TaskInput = {
  slug: string;
  name: string;
  description: string | null;
  kind: TaskKind;
  cron: string | null;
  at: Date | null;
  note: string | null;
  code: string | null;
  timeoutMs: number | null;
  wake: boolean;
};

// An ISO-8601 instant must carry an explicit offset (Z or ±hh:mm): a naive
// local timestamp is ambiguous and silently parsed in server-local time.
const ISO_OFFSET_RE = /(?:Z|[+-]\d{2}:?\d{2})$/;

function refuse(message: string): never {
  throw new ScheduleError('bad_request', message);
}

// A text field as given: trimmed; absent, null and empty are one "not
// given" (null). Any other type is the caller's mistake.
function text(field: string, value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value !== 'string') {
    refuse(`${field} must be a string`);
  }

  const trimmed = value.trim();

  return trimmed ? trimmed : null;
}

// The raw input, by the field names of the console's contract
// (CreateTaskRequest); the tool maps its snake_case arguments onto them.
export function parseTaskInput(raw: Record<string, unknown>, now = new Date()): TaskInput {
  const slug = text('slug', raw.slug);

  if (!slug) {
    refuse('slug is required');
  }

  if (!SLUG_PATTERN.test(slug) || slug.length > SLUG_MAX_LENGTH) {
    refuse(`slug must match ${String(SLUG_PATTERN)} and be at most ${SLUG_MAX_LENGTH} chars`);
  }

  const name = text('name', raw.name);

  if (!name) {
    refuse('name is required');
  }

  if (name.length > NAME_MAX_LENGTH) {
    refuse(`name must be at most ${NAME_MAX_LENGTH} chars`);
  }

  const description = text('description', raw.description);

  if (description && description.length > DESCRIPTION_MAX_LENGTH) {
    refuse(`description must be at most ${DESCRIPTION_MAX_LENGTH} chars`);
  }

  const kind = raw.kind;

  if (kind !== 'note' && kind !== 'program') {
    refuse('kind must be "note" or "program"');
  }

  const cron = text('cron', raw.cron);
  const atRaw = text('at', raw.at);
  const note = text('note', raw.note);

  if (cron && atRaw) {
    refuse('cron and at are mutually exclusive — a task has at most one trigger');
  }

  if (kind === 'note' && !note) {
    refuse('note is required for kind "note" — it is the content the secretary will act on');
  }

  if (kind === 'program' && note) {
    refuse('note applies only to kind "note" — a program has its code');
  }

  // The code of a program, kept as written: its lines are the lines an
  // error of a run names.
  if (raw.code !== undefined && raw.code !== null && typeof raw.code !== 'string') {
    refuse('code must be a string');
  }

  const code = typeof raw.code === 'string' && raw.code.trim() ? raw.code : null;

  if (kind !== 'program' && code) {
    refuse(`code applies only to kind "program" — leave it out for kind "${kind}"`);
  }

  if (kind === 'program') {
    if (!code) {
      refuse('code is required for kind "program" — it is what the trigger runs');
    }

    const problem = programSyntaxProblem(code);

    if (problem) {
      refuse(`code does not parse${problem.line === null ? '' : ` at line ${problem.line}`}: ${problem.text}. It is the body of an async function with only call, describe and console in scope.`);
    }
  }

  if (raw.wake !== undefined && raw.wake !== null && typeof raw.wake !== 'boolean') {
    refuse('wake must be a boolean');
  }

  const wake = raw.wake !== false;

  const timeoutRaw = raw.timeoutMs;

  if (timeoutRaw !== undefined && timeoutRaw !== null && typeof timeoutRaw !== 'number') {
    refuse('timeoutMs must be a number of milliseconds, or null for the default');
  }

  let timeoutMs: number | null = null;

  if (typeof timeoutRaw === 'number') {
    if (kind !== 'program') {
      refuse('timeoutMs applies only to kind "program"');
    }

    if (!Number.isInteger(timeoutRaw) || timeoutRaw < PROGRAM_TIMEOUT_MIN_MS || timeoutRaw > PROGRAM_TIMEOUT_MAX_MS) {
      refuse(`timeoutMs must be an integer between ${PROGRAM_TIMEOUT_MIN_MS} and ${PROGRAM_TIMEOUT_MAX_MS} (milliseconds), or null for the default ${PROGRAM_TIMEOUT_DEFAULT_MS}`);
    }

    timeoutMs = timeoutRaw;
  }

  if (cron) {
    try {
      assertValidCron(cron);
    } catch (error) {
      refuse(`cron expression "${cron}" is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (!cronNextRun(cron, now)) {
      refuse(`cron expression "${cron}" never yields a future moment`);
    }
  }

  let at: Date | null = null;

  if (atRaw) {
    if (!ISO_OFFSET_RE.test(atRaw)) {
      refuse('at must be an ISO 8601 instant with an explicit offset, e.g. "2026-08-09T09:00:00+03:00" or "...Z"');
    }

    at = new Date(atRaw);

    if (Number.isNaN(at.getTime())) {
      refuse(`at is not a valid ISO 8601 instant: "${atRaw}"`);
    }
  }

  return {
    slug,
    name,
    description,
    kind,
    cron,
    at,
    note,
    code,
    timeoutMs,
    wake,
  };
}
