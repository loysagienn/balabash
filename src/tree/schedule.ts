// The node `schedule`: the registry of scheduled tasks and the journal of
// their runs. A task is a note for the secretary or a program; the registry,
// its rules and the launch of a task are the schedule's own (src/schedule —
// one implementation for every door: this node, the console, the heart),
// and a change of the registry is authored by the calling thread. A manual
// run fires the task exactly as its trigger would: a program runs on behalf
// of the main thread of the workspace, whoever asked for the run.

import { z } from 'zod';
import type { ScheduledTaskModel } from '../../prisma-generated/models.ts';
import { CapabilityError, JsonValue, capability, namedType, node, type Caller, type ErrorKind } from '../catalog/index.ts';
import { config } from '../config/index.ts';
import type { RegistryAuthor } from '../core/registry-events.ts';
import { prisma } from '../db/client.ts';
import { ScheduleError, createTask, deleteTask, runTask, type ScheduleErrorCode } from '../schedule/commands.ts';
import { DESCRIPTION_MAX_LENGTH, NAME_MAX_LENGTH, SLUG_MAX_LENGTH, SLUG_PATTERN, parseTaskInput } from '../schedule/input.ts';
import { RUN_STATUSES, getRun, listRuns, type RunPosition, type RunSummary } from '../schedule/journal.ts';
import { PROGRAM_TIMEOUT_DEFAULT_MS, PROGRAM_TIMEOUT_MAX_MS, PROGRAM_TIMEOUT_MIN_MS } from '../schedule/programs.ts';
import { isTaskRunning } from '../schedule/running.ts';
import { taskView } from '../schedule/view.ts';

const wakeText =
  "true: the task's event starts the secretary's turn at once; false: it waits in the main thread for the next turn.";

export const ScheduledTask = namedType(
  'ScheduledTask',
  { description: 'One scheduled task of the workspace, with its trigger resolved to the next moment.' },
  z.strictObject({
    slug: z.string().describe('Unique id of the task.'),
    kind: z.enum(['note', 'program']),
    name: z.string(),
    description: z.string().nullable(),
    cron: z.string().nullable().describe('Evaluated in the schedule timezone; null when the task is not recurring.'),
    at: z.string().nullable().describe('One-shot moment, ISO 8601; null when the task is not one-shot.'),
    nextRunAt: z.string().nullable().describe('ISO 8601; null for a task without a trigger.'),
    note: z.string().nullable().describe('Kind note.'),
    code: z.string().nullable().describe('Kind program.'),
    timeoutSeconds: z.int().nullable().describe('Kind program.'),
    wake: z.boolean().describe(wakeText),
    running: z.boolean().describe('A run is in flight.'),
    createdBy: z.string().nullable().describe('Agent name, or "operator".'),
    createdAt: z.string().describe('ISO 8601.'),
  }),
);

type TaskValue = z.input<typeof ScheduledTask>;

// The kinds of the scheme. A row of a former kind is not a task of this
// node: its list does not show it.
const KINDS = ['note', 'program'] as const;

function taskValue(row: ScheduledTaskModel, now: Date): TaskValue {
  const view = taskView(row, now);
  const program = row.kind === 'program';

  return {
    slug: view.slug,
    kind: program ? 'program' : 'note',
    name: view.name,
    description: view.description,
    cron: view.cron,
    at: view.at?.toISOString() ?? null,
    nextRunAt: view.nextRunAt?.toISOString() ?? null,
    note: program ? null : view.note,
    code: program ? view.code : null,
    timeoutSeconds: program ? Math.round((view.timeoutMs ?? PROGRAM_TIMEOUT_DEFAULT_MS) / 1000) : null,
    wake: view.wake,
    running: isTaskRunning(view.slug),
    createdBy: view.createdBy,
    createdAt: view.createdAt.toISOString(),
  };
}

// A change of the registry is authored by the thread that asked for it.
function author(caller: Caller): RegistryAuthor {
  return { kind: 'thread', workspaceId: caller.workspaceId, threadId: caller.threadId };
}

const REFUSALS: Record<ScheduleErrorCode, ErrorKind> = {
  bad_request: 'invalid_input',
  not_found: 'not_found',
  conflict: 'conflict',
  replaced: 'conflict',
  sleeping: 'conflict',
  no_main_thread: 'conflict',
};

// A refusal of the schedule in the kinds of the catalog; anything else is a
// defect and stays what it is.
async function registry<T>(act: () => Promise<T> | T, wording: Partial<Record<ScheduleErrorCode, string>> = {}): Promise<T> {
  try {
    return await act();
  } catch (error) {
    if (error instanceof ScheduleError) {
      throw new CapabilityError(REFUSALS[error.code], wording[error.code] ?? error.message);
    }

    throw error;
  }
}

const noTask = (slug: string) => `The workspace has no task with the slug "${slug}".`;

const slugOfTask = z.string();

const createTaskCapability = capability({
  name: 'create_task',
  summary: 'Register a scheduled task: a note or a program, with or without a trigger',
  description:
    'Register a task for later execution. A note sends text to the main thread for the secretary to act on. A program runs code as `run_program` does. Without `cron` or `at`, the task runs only by hand. A one-shot fires at or after `at` and is consumed. If overdue at startup, it fires then. Missed cron times and triggers during a previous run are skipped.',
  inputRules: [{ atMostOne: ['cron', 'at'] }],
  input: z.strictObject({
    slug: z.string().max(SLUG_MAX_LENGTH).regex(SLUG_PATTERN).describe('Unique across the installation.'),
    name: z.string().max(NAME_MAX_LENGTH),
    description: z.string().max(DESCRIPTION_MAX_LENGTH).optional(),
    kind: z.enum(KINDS),
    cron: z.string().describe('Evaluated in the schedule timezone.').optional(),
    at: z.string().describe('ISO 8601 with an explicit offset.').optional(),
    note: z.string().describe('Kind note: the text delivered at the trigger.').optional(),
    code: z.string().describe('Kind program: the body of an async function, as `run_program` takes it.').optional(),
    timeoutSeconds: z
      .int()
      .min(PROGRAM_TIMEOUT_MIN_MS / 1000)
      .max(PROGRAM_TIMEOUT_MAX_MS / 1000)
      .default(PROGRAM_TIMEOUT_DEFAULT_MS / 1000)
      .describe('Kind program.'),
    wake: z.boolean().default(true).describe(wakeText),
  }),
  output: ScheduledTask,
  async run(input, { caller }) {
    const { timeoutSeconds, ...fields } = input;
    const now = new Date();

    // The limit of time is a program's: a note has none to keep.
    const { task } = await registry(
      async () =>
        createTask(
          caller.workspaceId,
          parseTaskInput({ ...fields, ...(input.kind === 'program' ? { timeoutMs: timeoutSeconds * 1000 } : {}) }, now),
          author(caller),
        ),
      {
        conflict: `The slug "${input.slug}" is already taken by a task of the installation: cancel that task first with \`schedule_cancel_task\` if it is of this workspace, or pick another slug.`,
      },
    );

    return taskValue(task, now);
  },
});

const listTasks = capability({
  name: 'list_tasks',
  summary: 'List the scheduled tasks of the workspace',
  description:
    'List the scheduled tasks of the workspace, oldest first, with the timezone their cron expressions are evaluated in.',
  input: z.strictObject({}),
  output: z.strictObject({
    timezone: z.string().describe('IANA name.'),
    tasks: z.array(ScheduledTask),
  }),
  async run(_input, { caller }) {
    const rows = await prisma.scheduledTask.findMany({
      where: { workspaceId: caller.workspaceId, kind: { in: [...KINDS] } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const now = new Date();

    return { timezone: config.scheduleTimezone, tasks: rows.map(row => taskValue(row, now)) };
  },
});

const cancelTask = capability({
  name: 'cancel_task',
  summary: 'Remove a scheduled task from the registry',
  description:
    'Remove a scheduled task from the registry: its trigger is disarmed and the slug becomes free. A run already in flight is not stopped.',
  input: z.strictObject({ slug: slugOfTask }),
  output: z.null(),
  async run({ slug }, { caller }) {
    if (!(await deleteTask(caller.workspaceId, slug, author(caller)))) {
      throw new CapabilityError('not_found', noTask(slug));
    }

    return null;
  },
});

const runTaskCapability = capability({
  name: 'run_task',
  summary: 'Run a scheduled task by hand, leaving its schedule untouched',
  description:
    'Run a scheduled task by hand, right now; the call only starts the run. The schedule is untouched: a one-shot task is not consumed. A program task gives the id of its journaled run.',
  input: z.strictObject({ slug: slugOfTask }),
  output: z.strictObject({
    runId: z.string().nullable().describe('The journaled run of a program task; null for a note.'),
  }),
  async run({ slug }, { caller }) {
    const outcome = await registry(() => runTask(caller.workspaceId, slug), {
      not_found: noTask(slug),
      no_main_thread: 'The workspace has no main thread to fire into.',
    });

    if (outcome.kind === 'already_running') {
      throw new CapabilityError(
        'conflict',
        `A run of the task "${slug}" is already going: wait for it to end (\`schedule_list_runs\` with the slug shows it) and run the task again.`,
      );
    }

    return { runId: outcome.runId };
  },
});

const runStatus = z.enum(RUN_STATUSES);

const runSummaryFields = {
  runId: z.string(),
  slug: z.string().describe('Slug of the task as it was at fire time.'),
  trigger: z.enum(['cron', 'at', 'manual']),
  status: runStatus.describe('failed: the program threw; aborted: killed by an app restart.'),
  startedAt: z.string().describe('ISO 8601.'),
  finishedAt: z.string().nullable().describe('ISO 8601.'),
  durationMs: z.int().nullable(),
};

function runSummaryValue(run: RunSummary) {
  return {
    runId: run.id,
    slug: run.slug,
    trigger: run.trigger,
    status: run.status,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
    durationMs: run.durationMs,
  };
}

// The cursor of the journal: the start of the last run of a page and its
// id. Opaque to the caller.
function runCursor(position: RunPosition): string {
  return `${position.startedAt.getTime()}:${position.id}`;
}

function cursorPosition(cursor: string | undefined): RunPosition | undefined {
  if (cursor === undefined) {
    return undefined;
  }

  const match = /^(\d{1,15}):([0-9a-f-]{1,64})$/i.exec(cursor);

  if (!match) {
    throw new CapabilityError(
      'invalid_input',
      'cursor is not a cursor of this list: pass `nextCursor` of the previous result as it is, or leave cursor out for the first page.',
    );
  }

  return { startedAt: new Date(Number(match[1])), id: match[2] as string };
}

const listRunsCapability = capability({
  name: 'list_runs',
  summary: 'List journaled runs of program tasks, newest first',
  description:
    'List the journaled runs of program tasks, newest first, without their code, value and console output. Every run is journaled, the silent ones included. Firings of note tasks are not runs.',
  input: z.strictObject({
    slug: z.string().describe('Only runs of this task.').optional(),
    status: runStatus.optional(),
    hasValue: z.boolean().describe('true: only runs that returned a value other than null.').optional(),
    limit: z.int().min(1).max(50).default(20),
    cursor: z.string().optional(),
  }),
  output: z.strictObject({
    runs: z.array(
      z.strictObject({
        ...runSummaryFields,
        hasValue: z.boolean().describe('The run returned a value other than null.'),
      }),
    ),
    nextCursor: z.string().nullable(),
  }),
  async run(input, { caller }) {
    const before = cursorPosition(input.cursor);
    const page = await listRuns(caller.workspaceId, {
      limit: input.limit,
      ...(input.slug !== undefined ? { slug: input.slug } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.hasValue !== undefined ? { hasValue: input.hasValue } : {}),
      ...(before ? { before } : {}),
    });

    return {
      runs: page.runs.map(run => ({ ...runSummaryValue(run), hasValue: run.hasValue })),
      nextCursor: page.next ? runCursor(page.next) : null,
    };
  },
});

const getRunCapability = capability({
  name: 'get_run',
  summary: 'Get one journaled run of a program task with its value and console output',
  description:
    'Get one journaled run of a program task: the code as it was at fire time, how the run ended, the value it returned or the error that ended it, and the last 16 KiB of its console output.',
  input: z.strictObject({ runId: z.string() }),
  output: z.strictObject({
    ...runSummaryFields,
    code: z.string(),
    value: JsonValue.nullable().describe('What the program returned; form set by the program. null for a run that is not ok.'),
    error: z.string().nullable().describe('What ended a failed or timed-out run; null otherwise.'),
    console: z.string(),
    consoleTruncated: z.boolean().describe('true: the console output was longer than the kept tail.'),
  }),
  async run({ runId }, { caller }) {
    const run = await getRun(caller.workspaceId, runId);

    if (!run) {
      throw new CapabilityError('not_found', `The workspace has no journaled run with the id "${runId}".`);
    }

    return {
      ...runSummaryValue(run),
      code: run.code,
      value: run.value,
      error: run.error,
      console: run.console,
      consoleTruncated: run.consoleTruncated,
    };
  },
});

export const schedule = node({
  name: 'schedule',
  summary:
    'Scheduled tasks: notes for the secretary and programs, run on a cron or at a moment; the journal of program runs. Come here to make something happen later or regularly.',
  guide: [
    {
      text: 'A program task holds the same code `run_program` takes: try the code there, then register it with a trigger.',
      requires: ['run_program'],
    },
    {
      text: 'What a scheduled program returns is delivered to the main thread as a schedule.fired event; returning null is silence. An exception or a timeout always lands there as a system.exception event.',
    },
    {
      text: 'A scheduled program works in the main thread: `send_message` reaches the user. A child started with `spawn_agent` is headless when available and sends questions to the secretary. Set headless to false for questions to reach the user in the child thread.',
      requires: ['send_message', 'spawn_agent'],
    },
    {
      text: 'To run a script of the workspace on a schedule, call `workspace_run_command` from the program.',
      requires: ['workspace_run_command'],
    },
    {
      text: 'The full check of a task is a manual run: register it without a trigger, run it with `schedule_run_task` and read the outcome with `schedule_get_run`; then cancel it and create it again with the trigger. A manual run executes the task for real.',
    },
    {
      text: 'A task remembers through its runs: `schedule_list_runs` with its slug and `hasValue` finds the runs that returned something, `schedule_get_run` gives the value.',
    },
    {
      text: 'A task is not edited: cancel it with `schedule_cancel_task` and create it again under the same slug.',
    },
  ],
  children: [createTaskCapability, listTasks, cancelTask, runTaskCapability, listRunsCapability, getRunCapability],
});
