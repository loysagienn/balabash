// The input of a new scheduled task, checked — one rule for the two doors
// of the registry: the create_task tool of the agents (src/schedule/tools.ts)
// and the console's POST /api/schedule/tasks (src/api/api.ts). Pure (no
// database): a TaskInput is what the registry row will hold; a refusal is a
// ScheduleError 'bad_request' whose message starts with the field at fault,
// so a form can put it under that field. The rules: the slug's shape and
// cap, a non-empty name, at most one trigger (a valid cron expression that
// yields a future moment, or an ISO 8601 instant with an explicit offset —
// a naive timestamp is ambiguous), a note for kind "note", a command for
// kind "command" with its folder inside the file area and its timeout in
// range; the command fields of another kind are a confusion, not ignored.
// A wrong type is a refusal, never "not given".

import { WorkspacePathError, sanitizeRelPath } from '../workspace/files.ts';
import { assertValidCron, cronNextRun } from './cron.ts';
import { ScheduleError } from './errors.ts';
import { JOB_TIMEOUT_DEFAULT_MS, JOB_TIMEOUT_MAX_MS, JOB_TIMEOUT_MIN_MS } from './engine.ts';

export const SLUG_PATTERN = /^[a-z][a-z0-9_-]*$/;
export const SLUG_MAX_LENGTH = 64;
// A name is a row's title, a description a line under it: the caps only
// keep a runaway body out (the project registry's caps).
export const NAME_MAX_LENGTH = 200;
export const DESCRIPTION_MAX_LENGTH = 2_000;

export type TaskKind = 'note' | 'code' | 'command';

// The row to write: the trigger as the registry stores it (`at` an
// instant), the command fields null for the other kinds, the note kept for
// kind "note" only.
export type TaskInput = {
  slug: string;
  name: string;
  description: string | null;
  kind: TaskKind;
  cron: string | null;
  at: Date | null;
  note: string | null;
  command: string | null;
  cwd: string | null;
  timeoutMs: number | null;
  reportOnSuccess: boolean;
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

  if (kind !== 'note' && kind !== 'code' && kind !== 'command') {
    refuse('kind must be "note", "code" or "command"');
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

  // The per-kind command fields: validated and stored only for kind
  // "command"; for other kinds a supplied value is rejected as confusion.
  const command = text('command', raw.command);
  const cwdRaw = text('cwd', raw.cwd);
  const timeoutRaw = raw.timeoutMs;

  if (timeoutRaw !== undefined && timeoutRaw !== null && typeof timeoutRaw !== 'number') {
    refuse('timeoutMs must be a number of milliseconds, or null for the default');
  }

  if (raw.reportOnSuccess !== undefined && raw.reportOnSuccess !== null && typeof raw.reportOnSuccess !== 'boolean') {
    refuse('reportOnSuccess must be a boolean');
  }

  const reportOnSuccess = raw.reportOnSuccess === true;
  const timeoutGiven = typeof timeoutRaw === 'number';

  if (kind !== 'command' && (command || cwdRaw || timeoutGiven || reportOnSuccess)) {
    refuse(`command, cwd, timeoutMs and reportOnSuccess apply only to kind "command" — null them for kind "${kind}"`);
  }

  let cwd: string | null = null;
  let timeoutMs: number | null = null;

  if (kind === 'command') {
    if (!command) {
      refuse('command is required for kind "command" — it is what the trigger executes (bash -c)');
    }

    if (cwdRaw) {
      try {
        cwd = sanitizeRelPath(cwdRaw, 'cwd');
      } catch (error) {
        if (error instanceof WorkspacePathError) {
          refuse(`cwd: ${error.message}`);
        }

        throw error;
      }
    }

    if (timeoutGiven) {
      if (!Number.isInteger(timeoutRaw) || timeoutRaw < JOB_TIMEOUT_MIN_MS || timeoutRaw > JOB_TIMEOUT_MAX_MS) {
        refuse(`timeoutMs must be an integer between ${JOB_TIMEOUT_MIN_MS} and ${JOB_TIMEOUT_MAX_MS} (milliseconds), or null for the default ${JOB_TIMEOUT_DEFAULT_MS}`);
      }

      timeoutMs = timeoutRaw;
    }
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
    // note is meaningless for a code body or a command — the registry does
    // not keep it there.
    note: kind === 'note' ? note : null,
    command: kind === 'command' ? command : null,
    cwd,
    timeoutMs,
    reportOnSuccess,
  };
}
