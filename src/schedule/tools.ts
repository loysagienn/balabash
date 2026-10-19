// The schedule tool server — a builtin server every agent bundle lists, so
// any agent (and the coordinator) can register, list,
// cancel and manually run scheduled tasks. Pure registry operations:
// create_task never spawns anything — orchestrating a code task's body is the
// scheduler agent's job. The audit of who registered what is free: these
// calls are journaled as tool.call.* in the calling agent's thread.

import type { JsonObject } from '../core/contract.ts';
import { prisma } from '../db/client.ts';
import { config } from '../config/index.ts';
import type { ToolFunction } from '../capabilities/mcp-client.ts';
import type { BuiltinServerCallContext, BuiltinToolServer } from '../capabilities/tool-manager.ts';
import type { ScheduledTaskModel } from '../../prisma-generated/models.ts';
import { workspaceTaskFile } from './catalog.ts';
import { JOB_TIMEOUT_DEFAULT_MS, JOB_TIMEOUT_MAX_MS, JOB_TIMEOUT_MIN_MS, isTaskRunning } from './engine.ts';
import { cronNextRun } from './heart.ts';
import { ScheduleError, createTask as createTaskCommand, deleteTask, isSleeping, runTask as runTaskCommand } from './commands.ts';
import { SLUG_MAX_LENGTH, SLUG_PATTERN, parseTaskInput } from './input.ts';

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
      'recurring instructions. kind "code": the trigger runs the run(ctx) body under the same slug — the ' +
      'workspace task file data/workspace/<userId>/tasks/<slug>.ts (live at the next fire, no build); the ' +
      'scheduler agent writes bodies; until the file exists the task SLEEPS — no errors, no runs. kind ' +
      '"command": a workspace job — the ' +
      'trigger runs the given shell command (bash -c) inside the workspace file area, with WORKSPACE_DB in ' +
      'the environment; armed immediately, no build or restart needed. Exit code 0 = success (silent unless ' +
      'report_on_success), anything else (or a timeout) = failure surfaced as a system.exception; every run ' +
      'is journaled — see list_job_runs / get_job_run. note is IGNORED for kinds code and command. ' +
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
          enum: ['note', 'code', 'command'],
          description:
            'note = data interpreted by the secretary; code = run(ctx) body (a file in the workspace tasks/ directory); command = a shell command run in the workspace file area.',
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
          description: 'The note delivered when the task fires — required for kind "note", IGNORED for kinds "code" and "command" (null it there).',
        },
        command: {
          type: ['string', 'null'],
          description:
            'kind "command" only (null otherwise): the shell command, executed verbatim via bash -c in the job\'s ' +
            'working directory. The environment is minimal (PATH, HOME, locale, TZ) plus WORKSPACE_DB = the ' +
            'workspace SQLite path; a project\'s own venv/node_modules are reachable by path, e.g. "./venv/bin/python collect.py".',
        },
        cwd: {
          type: ['string', 'null'],
          description:
            'kind "command" only: working directory as a path relative to the workspace file area, usually a ' +
            'project folder (e.g. "my-project"). Null = the file-area root.',
        },
        timeout_ms: {
          type: ['number', 'null'],
          description: `kind "command" only: kill timeout in milliseconds, ${JOB_TIMEOUT_MIN_MS}-${JOB_TIMEOUT_MAX_MS} (up to 5 hours). Null = default ${JOB_TIMEOUT_DEFAULT_MS} (10 minutes). On expiry the whole process group is killed and the run is journaled as "timeout".`,
        },
        report_on_success: {
          type: ['boolean', 'null'],
          description:
            'kind "command" only: when true, a successful run pushes a schedule.fired event with the stdout ' +
            'tail to the main thread (the script "speaks by printing"). Null/false = a success is silent — ' +
            'only the journal records it. Failures ALWAYS surface regardless of this flag.',
        },
      },
      required: ['slug', 'name', 'description', 'kind', 'cron', 'at', 'note', 'command', 'cwd', 'timeout_ms', 'report_on_success'],
      additionalProperties: false,
    },
  },
  {
    functionName: 'list_tasks',
    serverName: SCHEDULE_SERVER_NAME,
    toolName: 'list_tasks',
    description:
      'List the scheduled tasks of this workspace: slug, kind, name, trigger, the next cron fire time, ' +
      'whether a code task is sleeping (registered but without its body file), and for ' +
      'command tasks the command, working directory, timeout and report flag.',
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
      'Delete a scheduled task from the registry by slug. The trigger is disarmed immediately; a code ' +
      "task's body file in the workspace is untouched (it just stops being scheduled).",
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
      'it; a code task reports through the events it pushes (or a system.exception on failure); a command ' +
      'task returns its runId immediately — follow the outcome via get_job_run.',
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
      'List journaled runs of workspace jobs (kind "command" scheduled tasks), newest first: runId, slug, ' +
      'trigger, status (running | ok | failed | timeout | spawn_error | aborted), exit code, start time, ' +
      'duration. The journal keeps every run — a silent success is visible here even though it produced no ' +
      'events. Full output tails are behind get_job_run.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: ['string', 'null'], description: 'Only runs of this task slug, or null for all.' },
        status: {
          type: ['string', 'null'],
          enum: ['running', 'ok', 'failed', 'timeout', 'spawn_error', 'aborted', null],
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
      'Get one journaled workspace-job run by its runId: the executed command and working directory as they ' +
      'were at fire time, trigger, status, exit code, timing, and the stdout/stderr tails (last 16 KiB of ' +
      'each stream, with truncation flags).',
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
  return message.replace(/\btimeoutMs\b/g, 'timeout_ms').replace(/\breportOnSuccess\b/g, 'report_on_success');
}

// The input rule is the registry's one (input.ts, shared with the console's
// POST /api/schedule/tasks); the tool's snake_case arguments are mapped onto
// the contract's names, a refusal reads as the tool's error in its words.
async function createTask(args: JsonObject, ctx: BuiltinServerCallContext): Promise<string> {
  let outcome;

  try {
    const input = parseTaskInput({
      slug: args.slug,
      name: args.name,
      description: args.description,
      kind: args.kind,
      cron: args.cron,
      at: args.at,
      note: args.note,
      command: args.command,
      cwd: args.cwd,
      timeoutMs: args.timeout_ms,
      reportOnSuccess: args.report_on_success,
    });

    outcome = await createTaskCommand(ctx.workspaceId, input, { kind: 'thread', workspaceId: ctx.workspaceId, threadId: ctx.threadId });
  } catch (error) {
    throw error instanceof ScheduleError ? new Error(toolWords(error.message)) : error;
  }

  const { task } = outcome;
  const { slug, kind, at, cwd, timeoutMs, reportOnSuccess } = task;
  const note = typeof args.note === 'string' && args.note.trim() ? args.note.trim() : null;

  const lines = [`Task "${slug}" (${kind}) registered. Trigger: ${describeTrigger(task)}.`];

  if (at && at.getTime() <= Date.now()) {
    lines.push('The moment is already in the past — the task fires on the next heart pass and is consumed.');
  }

  if (kind === 'code') {
    if (outcome.sleeping) {
      lines.push(
        `The task SLEEPS: no run(ctx) body under slug "${slug}". It comes alive the moment ` +
          `${workspaceTaskFile(task.workspaceId, slug)} exists (no build or restart).`,
      );
    }

    if (note) {
      lines.push('Note: the "note" field is ignored for kind "code" and was not stored.');
    }
  }

  if (kind === 'command') {
    lines.push(
      `The job is armed immediately — no build or restart needed. It runs "bash -c" in "${cwd ?? '<file-area root>'}" ` +
        `with a ${timeoutMs ?? JOB_TIMEOUT_DEFAULT_MS} ms timeout; every run is journaled (list_job_runs / get_job_run), ` +
        `failures surface as system.exception${reportOnSuccess ? ', successes push a schedule.fired event' : ', successes are silent'}.`,
    );

    if (note) {
      lines.push('Note: the "note" field is ignored for kind "command" and was not stored.');
    }
  }

  return lines.join('\n');
}

async function listTasks(ctx: BuiltinServerCallContext): Promise<string> {
  const tasks = await prisma.scheduledTask.findMany({
    where: { workspaceId: ctx.workspaceId },
    orderBy: { createdAt: 'asc' },
  });

  if (!tasks.length) {
    return 'No scheduled tasks registered.';
  }

  const sleeping = new Set<string>();

  for (const task of tasks) {
    if (await isSleeping(task)) {
      sleeping.add(task.id);
    }
  }

  const lines = tasks.map(task => {
    const flags = [
      ...(sleeping.has(task.id) ? ['SLEEPING — no run(ctx) body file in the workspace tasks/'] : []),
      ...(isTaskRunning(task.slug) ? ['running right now'] : []),
    ];

    return [
      `- ${task.slug} (${task.kind}): ${task.name}`,
      `  trigger: ${describeTrigger(task)}${flags.length ? ` [${flags.join('; ')}]` : ''}`,
      ...(task.description ? [`  description: ${task.description}`] : []),
      ...(task.note ? [`  note: ${task.note}`] : []),
      ...(task.kind === 'command'
        ? [
            `  command: ${task.command}`,
            `  cwd: ${task.cwd ?? '<file-area root>'}, timeout ${task.timeoutMs ?? JOB_TIMEOUT_DEFAULT_MS} ms, ${task.reportOnSuccess ? 'reports on success' : 'silent on success'}`,
          ]
        : []),
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

      if (task.kind === 'command') {
        return (
          `Job "${slug}" started, runId ${outcome.runId}. It runs asynchronously — check the outcome with ` +
          `get_job_run {runId} (or list_job_runs); a failure also surfaces as a system.exception. The schedule is untouched.`
        );
      }

      return `Task "${slug}" started. It runs asynchronously; it reports only through the events it pushes (or a system.exception on failure). The schedule is untouched.`;
    case 'already_running':
      return `Task "${slug}" is already running — this manual run is skipped.`;
  }
}

// One journal row as a compact line: the answer to "when did it last run and
// how did it go" without the output tails.
function describeJobRun(run: {
  id: string;
  slug: string;
  trigger: string;
  status: string;
  exitCode: number | null;
  startedAt: Date;
  durationMs: number | null;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}): string {
  const parts = [
    `${run.startedAt.toISOString()} ${run.slug}: ${run.status}`,
    ...(run.exitCode !== null && run.status !== 'ok' ? [`exit ${run.exitCode}`] : []),
    ...(run.durationMs !== null ? [`${run.durationMs} ms`] : []),
    `trigger ${run.trigger}`,
    ...(run.stdoutTruncated || run.stderrTruncated ? ['output truncated'] : []),
  ];

  return `- ${parts.join(', ')}\n  runId ${run.id}`;
}

async function listJobRuns(args: JsonObject, ctx: BuiltinServerCallContext): Promise<string> {
  const slug = typeof args.slug === 'string' && args.slug.trim() ? args.slug.trim() : null;
  const status = typeof args.status === 'string' && args.status.trim() ? args.status.trim() : null;
  const limit =
    typeof args.limit === 'number' && Number.isFinite(args.limit)
      ? Math.min(Math.max(Math.floor(args.limit), 1), JOB_RUNS_MAX_LIMIT)
      : JOB_RUNS_DEFAULT_LIMIT;

  const runs = await prisma.jobRun.findMany({
    where: {
      workspaceId: ctx.workspaceId,
      ...(slug ? { slug } : {}),
      ...(status ? { status } : {}),
    },
    orderBy: { startedAt: 'desc' },
    take: limit,
  });

  if (!runs.length) {
    return `No journaled job runs${slug ? ` for slug "${slug}"` : ''}${status ? ` with status "${status}"` : ''}.`;
  }

  return runs.map(describeJobRun).join('\n');
}

async function getJobRun(args: JsonObject, ctx: BuiltinServerCallContext): Promise<string> {
  const runId = typeof args.runId === 'string' ? args.runId.trim() : '';

  if (!runId) {
    throw new Error('a non-empty runId is required');
  }

  const run = await prisma.jobRun.findFirst({ where: { id: runId, workspaceId: ctx.workspaceId } });

  if (!run) {
    throw new Error(`no job run "${runId}" in this workspace`);
  }

  return [
    `Run ${run.id} of job "${run.slug}" (trigger ${run.trigger}): ${run.status}`,
    `command: ${run.command}`,
    `cwd: ${run.cwd ?? '<file-area root>'}`,
    `started ${run.startedAt.toISOString()}${run.finishedAt ? `, finished ${run.finishedAt.toISOString()}` : ''}${run.durationMs !== null ? `, ${run.durationMs} ms` : ''}${run.exitCode !== null ? `, exit code ${run.exitCode}` : ''}`,
    `--- stdout${run.stdoutTruncated ? ' (tail, truncated)' : ''} ---`,
    run.stdoutTail || '<empty>',
    `--- stderr${run.stderrTruncated ? ' (tail, truncated)' : ''} ---`,
    run.stderrTail || '<empty>',
  ].join('\n');
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
