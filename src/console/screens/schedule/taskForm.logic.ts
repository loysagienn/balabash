// The rules of the "New task" form (design: ScheduleScreen create / modal):
// the values a form holds, the slug derived from the name until the
// operator edits it, the checks the server makes (src/schedule/input.ts —
// the server's law, repeated here so a mistake shows under the field
// before the call), the words beside the schedule (the expression spelled
// out and its next run in the schedule's time zone) and the one-shot
// moment (typed as a wall clock of that zone — neither is read before the
// zone is known), the timeout as a person
// writes it ("10m", "1h 30m"), the request the form sends, and which field
// a server refusal belongs to. Pure, tested.

import type { CreateTaskRequest } from '../../../api/contract.ts';
import { capSlug, slugWords } from '../../lib/text/slug.ts';
import { cronWords } from './cron-words.ts';
import { nextCronRun } from './next-run.ts';
import { whenLabelIn } from './ScheduleScreen.logic.ts';

export const NAME_MAX_LENGTH = 200;
export const SLUG_MAX_LENGTH = 64;
export const DESCRIPTION_MAX_LENGTH = 2_000;
export const SLUG_PATTERN = /^[a-z][a-z0-9_-]*$/;
export const TIMEOUT_MIN_MS = 1_000;
export const TIMEOUT_MAX_MS = 18_000_000;
export const TIMEOUT_DEFAULT_MS = 600_000;

export type TaskKind = 'note' | 'code' | 'command';
// On schedule (cron) · Once (a moment) · Manual only (no trigger — a
// stored procedure run by "Run now" or an agent).
export type TaskWhen = 'cron' | 'at' | 'manual';

export type TaskFormValues = {
  name: string;
  slug: string;
  description: string;
  kind: TaskKind;
  when: TaskWhen;
  cron: string;
  // A wall clock of the schedule's time zone, as <input type="datetime-local">
  // gives it: "YYYY-MM-DDTHH:mm".
  at: string;
  note: string;
  command: string;
  cwd: string;
  timeout: string;
  reportOnSuccess: boolean;
};

export type TaskFormField = Exclude<keyof TaskFormValues, 'reportOnSuccess'>;
export type TaskFormErrors = Partial<Record<TaskFormField, string>>;

// The design opens on a command job on a schedule.
export const initialTaskForm: TaskFormValues = { name: '', slug: '', description: '', kind: 'command', when: 'cron', cron: '', at: '', note: '', command: '', cwd: '', timeout: '', reportOnSuccess: false };

export const KIND_LABELS: Record<TaskKind, string> = { note: 'Reminder', code: 'Code', command: 'Command' };
export const WHEN_LABELS: Record<TaskWhen, string> = { cron: 'On schedule', at: 'Once', manual: 'Manual only' };

// "DB backup" → "db-backup", "Напомнить про воду" → "napomnit-pro-vodu": a
// letter first (the slug rule), at most 64 characters.
export function slugFromName(name: string): string {
  return capSlug(slugWords(name).replace(/^[^a-z]+/, ''), SLUG_MAX_LENGTH);
}

// One change of the form: the slug follows the name until the operator
// typed a slug of their own.
export function changeTaskForm(values: TaskFormValues, field: TaskFormField | 'reportOnSuccess', value: string | boolean): TaskFormValues {
  if (field === 'reportOnSuccess') {
    return { ...values, reportOnSuccess: value === true };
  }

  if (field === 'name' && typeof value === 'string' && values.slug === slugFromName(values.name)) {
    return { ...values, name: value, slug: slugFromName(value) };
  }

  return { ...values, [field]: value };
}

// "10m", "1h 30m", "45s", "2h" → milliseconds; empty — the default (null);
// a bare number or an unknown shape — an error (a unit is needed: "90" is
// not a timeout). The range is the server's (1 s – 5 h).
export function parseTimeout(text: string): { ms: number | null; error?: undefined } | { ms?: undefined; error: string } {
  const value = text.trim().toLowerCase();

  if (!value) {
    return { ms: null };
  }

  const match = /^(?:(\d+)\s*h)?\s*(?:(\d+)\s*m(?:in)?)?\s*(?:(\d+)\s*s)?$/.exec(value);

  if (!match || (match[1] === undefined && match[2] === undefined && match[3] === undefined)) {
    return { error: 'Write it with units: 10m, 1h 30m, 45s.' };
  }

  const ms = (Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0)) * 1000;

  if (ms < TIMEOUT_MIN_MS || ms > TIMEOUT_MAX_MS) {
    return { error: 'Between 1s and 5h.' };
  }

  return { ms };
}

// The zone's wall clock of an instant, "YYYY-MM-DDTHH:mm:ss" (Intl).
function wallOf(instant: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(instant));
  const get = (type: string) => parts.find(part => part.type === type)?.value ?? '00';

  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`;
}

// The offset of a zone at an instant, in milliseconds (positive east of
// UTC): the zone's wall clock of the instant against the instant's UTC clock.
function zoneOffsetMs(instant: number, timeZone: string): number {
  return Date.parse(`${wallOf(instant, timeZone)}Z`) - Math.floor(instant / 1000) * 1000;
}

// The instant whose wall clock in the zone is the given "YYYY-MM-DDTHH:mm"
// (seconds optional): the UTC reading of the clock minus the zone's offset
// there — the offset read at the clock itself and again at the first
// answer, so a clock near a DST change lands on the right side; the answer
// whose wall clock reads back as typed wins; a clock in the spring-forward
// gap (no such wall time) lands after the gap, as Date does. A zone the
// browser does not know, or a clock it cannot read — null.
export function instantInZone(wall: string, timeZone: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(wall.trim());

  if (!match) {
    return null;
  }

  const asUtc = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6] ?? 0));

  if (Number.isNaN(asUtc)) {
    return null;
  }

  try {
    const typed = wallOf(asUtc, 'UTC');
    const first = asUtc - zoneOffsetMs(asUtc, timeZone);
    const second = asUtc - zoneOffsetMs(first, timeZone);

    if (wallOf(second, timeZone) === typed) {
      return new Date(second);
    }

    return new Date(wallOf(first, timeZone) === typed ? first : Math.max(first, second));
  } catch {
    return null;
  }
}

// The schedule's time zone is a fact of the server (GET /api/settings):
// until it has come, neither an expression nor a moment can be read — the
// browser's own zone would promise a time the server does not keep, and a
// typed moment would change its meaning when the fact comes. The form says
// so and refuses those triggers; "Manual only" needs no zone.
export const ZONE_PENDING = 'Can’t be read until the schedule’s time zone is known.';

export function zoneNoteWords(failure: string | null): string {
  return failure
    ? `Couldn’t read the schedule’s time zone — ${failure}. A schedule and a moment are read in it; “Manual only” needs none.`
    : 'Reading the schedule’s time zone — a schedule and a moment are read in it.';
}

export type CronFacts = { valid: boolean; words: string | null; next: Date | null };

// The expression as croner reads it, in the zone: its words and its next
// moment; an expression croner refuses, or one with no future moment, is
// not valid.
export function cronFacts(cron: string, now: Date, zone: string): CronFacts {
  const text = cron.trim();

  if (!text) {
    return { valid: false, words: null, next: null };
  }

  const next = nextCronRun(text, now, zone);

  return { valid: next !== null, words: next ? cronWords(text) : null, next };
}

// "Daily at 4:00 · next run tomorrow, 4:00 (Europe/Moscow)" — the words of a
// valid expression; "On schedule · …" for a shape the words do not cover.
export function cronHint(facts: CronFacts, now: Date, zone: string): string | null {
  if (!facts.valid || !facts.next) {
    return null;
  }

  const words = facts.words ?? 'on schedule';

  return `${words.charAt(0).toUpperCase()}${words.slice(1)} · next run ${whenLabelIn(facts.next, now, zone)} (${zone})`;
}

// The hint under the schedule field: the expression's words and next run,
// else what the five fields are, on the clock of the schedule's zone.
export function cronFieldHint(cron: string, now: Date, zone: string | null): string {
  const fields = `Minute, hour, day of month, month, day of week — the clock of ${zone ?? 'the schedule’s time zone'}.`;

  return zone ? (cronHint(cronFacts(cron, now, zone), now, zone) ?? fields) : fields;
}

// The hint under the moment: when it fires, in the zone; a moment already
// past fires at once (the server's rule) and the hint says so.
export function atHint(instant: Date | null, now: Date, zone: string | null): string {
  if (!zone) {
    return 'The clock of the schedule’s time zone.';
  }

  if (!instant) {
    return `The clock of ${zone}, the schedule’s time zone.`;
  }

  if (instant.getTime() <= now.getTime()) {
    return `That moment is past — the task fires at once and is consumed (${zone}).`;
  }

  return `Fires ${whenLabelIn(instant, now, zone)} (${zone}), then the task is consumed.`;
}

// What a code task is: a body an agent writes, named by the slug.
export function codeHint(slug: string): string {
  return `A run(ctx) body written by the scheduler agent — tasks/${slug.trim() || '<slug>'}.ts in the workspace or the repository. Until it exists the task sleeps.`;
}

// The folder as the form sends it: trimmed, "/" separators, without a
// leading "./" or a trailing "/" (the server reads an empty last segment
// as a fault); empty — the file-area root.
export function normalizeCwd(cwd: string): string {
  return cwd.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

// A folder of the file area: relative, no "..", no absolute path (the
// server's sanitizeRelPath, before the call).
export function cwdError(cwd: string): string | null {
  const value = normalizeCwd(cwd);

  if (!value) {
    return null;
  }

  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) {
    return 'A folder of the file area, relative to its root.';
  }

  if (value.split('/').some(segment => !segment || segment === '.' || segment === '..')) {
    return 'No “..”, “.” or empty parts in the path.';
  }

  return null;
}

// What the form shows under its fields before the call — the same rules as
// the server's parser, in the form's words; a schedule or a moment while
// the zone is unknown (null) is not sent.
export function validateTaskForm(values: TaskFormValues, now: Date, zone: string | null): TaskFormErrors {
  const errors: TaskFormErrors = {};
  const name = values.name.trim();
  const slug = values.slug.trim();

  if (!name) {
    errors.name = 'A name is required.';
  } else if (name.length > NAME_MAX_LENGTH) {
    errors.name = `At most ${NAME_MAX_LENGTH} characters.`;
  }

  if (!slug) {
    errors.slug = 'A slug is required.';
  } else if (!SLUG_PATTERN.test(slug)) {
    errors.slug = 'Lowercase letters, digits, dashes and underscores, starting with a letter.';
  } else if (slug.length > SLUG_MAX_LENGTH) {
    errors.slug = `At most ${SLUG_MAX_LENGTH} characters.`;
  }

  if (values.description.trim().length > DESCRIPTION_MAX_LENGTH) {
    errors.description = `At most ${DESCRIPTION_MAX_LENGTH} characters.`;
  }

  if (values.when === 'cron') {
    if (!values.cron.trim()) {
      errors.cron = 'A cron expression is required: minute, hour, day of month, month, day of week.';
    } else if (!zone) {
      errors.cron = ZONE_PENDING;
    } else if (!cronFacts(values.cron, now, zone).valid) {
      errors.cron = 'Not a cron expression croner reads, or one with no future moment.';
    }
  } else if (values.when === 'at') {
    if (!values.at.trim()) {
      errors.at = 'A moment is required.';
    } else if (!zone) {
      errors.at = ZONE_PENDING;
    } else if (!instantInZone(values.at, zone)) {
      errors.at = 'A date and a time of day.';
    }
  }

  if (values.kind === 'note' && !values.note.trim()) {
    errors.note = 'A note is required — it is what the secretary acts on.';
  }

  if (values.kind === 'command') {
    if (!values.command.trim()) {
      errors.command = 'A command is required — it is what the trigger runs (bash -c).';
    }

    const cwd = cwdError(values.cwd);

    if (cwd) {
      errors.cwd = cwd;
    }

    const timeout = parseTimeout(values.timeout);

    if (timeout.error) {
      errors.timeout = timeout.error;
    }
  }

  return errors;
}

// The request the form sends, trimmed, the fields of other kinds null, the
// moment as an instant with an explicit offset (the server's rule). Only
// for values that passed validateTaskForm.
export function taskRequest(values: TaskFormValues, zone: string | null): CreateTaskRequest {
  const command = values.kind === 'command';

  return {
    slug: values.slug.trim(),
    name: values.name.trim(),
    description: values.description.trim() || null,
    kind: values.kind,
    cron: values.when === 'cron' ? values.cron.trim() : null,
    at: values.when === 'at' && zone ? (instantInZone(values.at, zone)?.toISOString() ?? null) : null,
    note: values.kind === 'note' ? values.note.trim() : null,
    command: command ? values.command.trim() : null,
    cwd: command ? normalizeCwd(values.cwd) || null : null,
    timeoutMs: command ? (parseTimeout(values.timeout).ms ?? null) : null,
    reportOnSuccess: command ? values.reportOnSuccess : false,
  };
}

// The field a server refusal is about — the server's messages start with
// the field at fault (src/schedule/input.ts); a message naming none is the
// form's own line.
export function fieldOfTaskFailure(message: string): TaskFormField | null {
  const head = message.toLowerCase();
  const fields: [RegExp, TaskFormField][] = [
    [/^slug\b/, 'slug'],
    [/^name\b/, 'name'],
    [/^description\b/, 'description'],
    [/^note\b/, 'note'],
    [/^command\b/, 'command'],
    [/^cwd\b/, 'cwd'],
    [/^timeoutms\b/, 'timeout'],
    [/^cron\b/, 'cron'],
    [/^at\b/, 'at'],
  ];

  for (const [pattern, field] of fields) {
    if (pattern.test(head)) {
      return field;
    }
  }

  return null;
}
