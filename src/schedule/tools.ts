// The schedule tool server — a builtin server every agent bundle lists, so
// any agent (and the coordinator) can register, list,
// cancel and manually run scheduled tasks. Pure registry operations:
// create_task registers a note or program. These calls are journaled as tool.call.* in the calling agent's thread.

import type { JsonObject } from '../core/contract.ts';
import { prisma } from '../db/client.ts';
import { config } from '../config/index.ts';
import type { ToolFunction } from '../capabilities/mcp-client.ts';
import type { BuiltinServerCallContext, BuiltinToolServer } from '../capabilities/tool-manager.ts';
import type { ScheduledTaskModel } from '../../prisma-generated/models.ts';
import { PROGRAM_TIMEOUT_DEFAULT_MS, PROGRAM_TIMEOUT_MAX_MS, PROGRAM_TIMEOUT_MIN_MS, isTaskRunning } from './programs.ts';
import { getRun, listRuns, RUN_STATUSES } from './journal.ts';
import type { RunStatus } from './run-record.ts';
import { cronNextRun } from './cron.ts';
import { ScheduleError, createTask as createTaskCommand, deleteTask, runTask as runTaskCommand } from './commands.ts';
import { SLUG_MAX_LENGTH, SLUG_PATTERN, TASK_KINDS, parseTaskInput } from './input.ts';

export const SCHEDULE_SERVER_NAME = 'schedule';

const JOB_RUNS_DEFAULT_LIMIT = 20;
const JOB_RUNS_MAX_LIMIT = 50;

const FUNCTIONS: ToolFunction[] = [
  {
    functionName: 'create_task',
    serverName: SCHEDULE_SERVER_NAME,
    toolName: 'create_task',
    description:
      'Register a named scheduled task. kind "note": at the trigger moment the note falls into the main ' +
      'thread as a schedule.fired event and the secretary interprets it — use this for reminders and ' +
      'recurring instructions. kind "program": run an async JavaScript function body with call, describe ' +
      'and console. Return a JSON value for the main thread or null for silence. Errors and timeouts surface ' +
      'as system.exception. Every program run is journaled (list_job_runs / get_job_run). ' +
      'The trigger is optional: cron (recurring; evaluated in the ' +
      `"${config.scheduleTimezone}" timezone; alarm-clock semantics — a moment missed while the app was ` +
      'down is skipped) or at (one-shot, "not before this instant"; a past instant fires immediately; ' +
      'firing consumes the task). No retries, no catch-up, no pause/resume. With neither trigger the task ' +
      'is a stored procedure started only via run_task. This call only writes the registry — it never ' +
      'spawns agents or runs anything.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: {
          type: 'string',
          description: `Unique task id, ${String(SLUG_PATTERN)}, at most ${SLUG_MAX_LENGTH} chars. To edit a task, cancel it and create it again under the same slug.`,
        },
        name: { type: 'string', description: 'Short human-readable name.' },
        description: { type: ['string', 'null'], description: 'What the task is for, or null.' },
        kind: {
          type: 'string',
          enum: [...TASK_KINDS],
          description:
            'note = text interpreted by the secretary; program = JavaScript stored in the task.',
        },
        cron: {
          type: ['string', 'null'],
          description: `Cron expression (e.g. "0 9 * * *"), evaluated in the "${config.scheduleTimezone}" timezone. Null unless the task is recurring. Mutually exclusive with "at".`,
        },
        at: {
          type: ['string', 'null'],
          description: 'One-shot moment as an absolute ISO 8601 instant WITH an explicit offset (e.g. "2026-08-09T09:00:00+03:00" or "...Z"). Null unless one-shot. Mutually exclusive with "cron".',
        },
        note: {
          type: ['string', 'null'],
          description: 'The note delivered when the task fires — required for kind "note", null for kind "program".',
        },
        code: { type: ['string', 'null'], description: 'Kind program: body of an async function. Null for a note.' },
        timeout_ms: {
          type: ['number', 'null'],
          description: `Kind program: time limit in milliseconds, ${PROGRAM_TIMEOUT_MIN_MS}-${PROGRAM_TIMEOUT_MAX_MS}. Null = default ${PROGRAM_TIMEOUT_DEFAULT_MS}.`,
        },
        wake: { type: ['boolean', 'null'], description: "Whether schedule.fired starts a secretary turn immediately. False leaves it for the next turn. Default true." },
      },
      required: ['slug', 'name', 'description', 'kind', 'cron', 'at', 'note', 'code', 'timeout_ms', 'wake'],
      additionalProperties: false,
    },
  },
  {
    functionName: 'list_tasks',
    serverName: SCHEDULE_SERVER_NAME,
    toolName: 'list_tasks',
    description:
      'List the scheduled tasks of this workspace: slug, kind, name, trigger, the next cron fire time, note or program code, and wake flag.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    functionName: 'cancel_task',
    serverName: SCHEDULE_SERVER_NAME,
    toolName: 'cancel_task',
    description:
      'Delete a scheduled task from the registry by slug. The trigger is disarmed immediately.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'The slug of the task to delete.' },
      },
      required: ['slug'],
      additionalProperties: false,
    },
  },
  {
    functionName: 'run_task',
    serverName: SCHEDULE_SERVER_NAME,
    toolName: 'run_task',
    description:
      'Run a scheduled task manually, right now — works for any task, with or without a trigger. The ' +
      'action executes exactly as on a trigger fire, but the schedule is untouched: a one-shot task is ' +
      'NOT consumed, a cron task keeps its next moment. The run is asynchronous — this call only starts ' +
      'it. A program returns its runId immediately — follow the outcome via get_job_run.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'The slug of the task to run.' },
      },
      required: ['slug'],
      additionalProperties: false,
    },
  },
  {
    functionName: 'list_job_runs',
    serverName: SCHEDULE_SERVER_NAME,
    toolName: 'list_job_runs',
    description:
      'List journaled runs of scheduled programs, newest first. Full results and console output are behind get_job_run.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: ['string', 'null'], description: 'Only runs of this task slug, or null for all.' },
        status: {
          type: ['string', 'null'],
          enum: [...RUN_STATUSES, null],
          description: 'Only runs with this status, or null for all.',
        },
        limit: {
          type: ['number', 'null'],
          description: `How many runs to return, at most ${JOB_RUNS_MAX_LIMIT}. Null = ${JOB_RUNS_DEFAULT_LIMIT}.`,
        },
      },
      required: ['slug', 'status', 'limit'],
      additionalProperties: false,
    },
  },
  {
    functionName: 'get_job_run',
    serverName: SCHEDULE_SERVER_NAME,
    toolName: 'get_job_run',
    description:
      'Get one scheduled program run by runId: its code, trigger, status, timing, return value, error and console output.',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string', description: 'The run id, e.g. from run_task, list_job_runs or a system.exception payload.' },
      },
      required: ['runId'],
      additionalProperties: false,
    },
  },
];

function requireSlug(args: JsonObject): string {
  const slug = typeof args.slug === 'string' ? args.slug.trim() : '';

  if (!slug) {
    throw new Error('a non-empty slug is required');
  }

  return slug;
}

function describeTrigger(task: ScheduledTaskModel): string {
  if (task.cron) {
    const next = cronNextRun(task.cron, new Date());

    return `cron "${task.cron}" (${config.scheduleTimezone}), next fire ${next ? next.toISOString() : 'never'}`;
  }

  if (task.at) {
    return `once, not before ${task.at.toISOString()}`;
  }

  return 'no trigger (manual run_task only)';
}

// A refusal of the shared parser names the contract's fields; the tool's
// arguments are snake_case.
function toolWords(message: string): string {
  return message.replace(/\btimeoutMs\b/g, 'timeout_ms');
}

// The input rule is the registry's one (input.ts, shared with the console's
// POST /api/schedule/tasks); the tool's snake_case arguments are mapped onto
// the contract's names, a refusal reads as the tool's error in its words.
async function createTask(args: JsonObject, ctx: BuiltinServerCallContext): Promise<string> {
  let task;

  try {
    const input = parseTaskInput({
      slug: args.slug,
      name: args.name,
      description: args.description,
      kind: args.kind,
      cron: args.cron,
      at: args.at,
      note: args.note,
      code: args.code,
      timeoutMs: args.timeout_ms,
      wake: args.wake,
    });

    task = await createTaskCommand(ctx.workspaceId, input, { kind: 'thread', workspaceId: ctx.workspaceId, threadId: ctx.threadId });
  } catch (error) {
    throw error instanceof ScheduleError ? new Error(toolWords(error.message)) : error;
  }

  const { slug, kind, at } = task;
  const lines = [`Task "${slug}" (${kind}) registered. Trigger: ${describeTrigger(task)}.`];

  if (at && at.getTime() <= Date.now()) {
    lines.push('The moment is already in the past — the task fires on the next heart pass and is consumed.');
  }

  return lines.join('\n');
}

async function listTasks(ctx: BuiltinServerCallContext): Promise<string> {
  const tasks = await prisma.scheduledTask.findMany({
    where: { workspaceId: ctx.workspaceId, kind: { in: [...TASK_KINDS] } },
    orderBy: { createdAt: 'asc' },
  });

  if (!tasks.length) {
    return 'No scheduled tasks registered.';
  }

  const lines = tasks.map(task => {
    return [
      `- ${task.slug} (${task.kind}): ${task.name}`,
      `  trigger: ${describeTrigger(task)}${isTaskRunning(task.slug) ? ' [running right now]' : ''}`,
      ...(task.description ? [`  description: ${task.description}`] : []),
      ...(task.note ? [`  note: ${task.note}`] : []),
      ...(task.kind === 'program' ? [`  code: ${task.code}`, `  timeout: ${task.timeoutMs ?? PROGRAM_TIMEOUT_DEFAULT_MS} ms`] : []),
      `  wake: ${task.wake}`,
      `  created ${task.createdAt.toISOString()}${task.createdBy ? ` by ${task.createdBy}` : ''}`,
    ].join('\n');
  });

  return lines.join('\n');
}

// The delete and the manual run are the shared commands of
// src/schedule/commands.ts (the console's endpoints run the same); here
// only the model's reply is worded.
async function cancelTask(args: JsonObject, ctx: BuiltinServerCallContext): Promise<string> {
  const slug = requireSlug(args);
  const task = await deleteTask(ctx.workspaceId, slug, { kind: 'thread', workspaceId: ctx.workspaceId, threadId: ctx.threadId });

  if (!task) {
    throw new Error(`no task with slug "${slug}" in this workspace`);
  }

  return `Task "${slug}" deleted; its trigger is disarmed.`;
}

async function runTask(args: JsonObject, ctx: BuiltinServerCallContext): Promise<string> {
  const slug = requireSlug(args);
  let outcome;

  try {
    outcome = await runTaskCommand(ctx.workspaceId, slug);
  } catch (error) {
    // A refusal of the command reads as the tool's error, in its words.
    throw error instanceof ScheduleError ? new Error(error.message) : error;
  }

  const { task } = outcome;

  switch (outcome.kind) {
    case 'fired':
      if (task.kind === 'note') {
        return `Task "${slug}" fired — the note landed in the main thread.`;
      }

      return `Program "${slug}" started, runId ${outcome.runId}. Check the outcome with get_job_run. The schedule is untouched.`;
    case 'already_running':
      return `Task "${slug}" is already running — this manual run is skipped.`;
  }
}

async function listJobRuns(args: JsonObject, ctx: BuiltinServerCallContext): Promise<string> {
  const slug = typeof args.slug === 'string' && args.slug.trim() ? args.slug.trim() : null;
  const status = typeof args.status === 'string' && args.status.trim() ? args.status.trim() : null;
  const limit =
    typeof args.limit === 'number' && Number.isFinite(args.limit)
      ? Math.min(Math.max(Math.floor(args.limit), 1), JOB_RUNS_MAX_LIMIT)
      : JOB_RUNS_DEFAULT_LIMIT;

  if (status && !RUN_STATUSES.includes(status as RunStatus)) {
    throw new Error('Unknown run status');
  }
  const { runs } = await listRuns(ctx.workspaceId, { limit, ...(slug ? { slug } : {}), ...(status ? { status: status as RunStatus } : {}) });

  if (!runs.length) {
    return `No journaled job runs${slug ? ` for slug "${slug}"` : ''}${status ? ` with status "${status}"` : ''}.`;
  }

  return JSON.stringify(runs);
}

async function getJobRun(args: JsonObject, ctx: BuiltinServerCallContext): Promise<string> {
  const runId = typeof args.runId === 'string' ? args.runId.trim() : '';

  if (!runId) {
    throw new Error('a non-empty runId is required');
  }

  const run = await getRun(ctx.workspaceId, runId);

  if (!run) {
    throw new Error(`no job run "${runId}" in this workspace`);
  }

  return JSON.stringify(run);
}

export function createScheduleToolServer(): BuiltinToolServer {
  return {
    name: SCHEDULE_SERVER_NAME,
    functionNames: FUNCTIONS.map(fn => fn.functionName),

    getFunctions: async () => FUNCTIONS,

    call: async (toolName, args, ctx) => {
      switch (toolName) {
        case 'create_task':
          return createTask(args, ctx);
        case 'list_tasks':
          return listTasks(ctx);
        case 'cancel_task':
          return cancelTask(args, ctx);
        case 'run_task':
          return runTask(args, ctx);
        case 'list_job_runs':
          return listJobRuns(args, ctx);
        case 'get_job_run':
          return getJobRun(args, ctx);
        default:
          throw new Error(`Unknown schedule tool "${toolName}"`);
      }
    },
  };
}
