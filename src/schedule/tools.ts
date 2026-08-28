// The schedule tool server — a builtin server every agent bundle lists, so
// any agent (and the coordinator) can register, list,
// cancel and manually run scheduled tasks. Pure registry operations:
// create_task never spawns anything — orchestrating a code task's body is the
// scheduler agent's job. The audit of who registered what is free: these
// calls are journaled as tool.call.* in the calling agent's thread.

import type { JsonObject } from '../core/contract.ts';
import { getThread } from '../core/threads.ts';
import { prisma } from '../db/client.ts';
import { config } from '../config/index.ts';
import type { ToolFunction } from '../capabilities/mcp-client.ts';
import type { BuiltinServerCallContext, BuiltinToolServer } from '../capabilities/tool-manager.ts';
import type { ScheduledTaskModel } from '../../prisma-generated/models.ts';
import { WorkspacePathError, sanitizeRelPath } from '../workspace/files.ts';
import { getTaskBody } from './catalog.ts';
import {
  JOB_TIMEOUT_DEFAULT_MS,
  JOB_TIMEOUT_MAX_MS,
  JOB_TIMEOUT_MIN_MS,
  fireTask,
  isTaskRunning,
} from './engine.ts';
import { assertValidCron, cronNextRun } from './heart.ts';

export const SCHEDULE_SERVER_NAME = 'schedule';

const SLUG_PATTERN = /^[a-z][a-z0-9_-]*$/;
const SLUG_MAX_LENGTH = 64;

const JOB_RUNS_DEFAULT_LIMIT = 20;
const JOB_RUNS_MAX_LIMIT = 50;

// An ISO-8601 instant must carry an explicit offset (Z or ±hh:mm): a naive
// local timestamp is ambiguous and silently parsed in server-local time.
const ISO_OFFSET_RE = /(?:Z|[+-]\d{2}:?\d{2})$/;

const FUNCTIONS: ToolFunction[] = [
  {
    functionName: 'create_task',
    serverName: SCHEDULE_SERVER_NAME,
    toolName: 'create_task',
    description:
      'Register a named scheduled task. kind "note": at the trigger moment the note falls into the main ' +
      'thread as a schedule.fired event and the secretary interprets it — use this for reminders and ' +
      'recurring instructions. kind "code": the trigger runs the run(ctx) body registered under the same ' +
      'slug in the repository tasks/ catalog (the scheduler agent ships bodies; until the body is built ' +
      'and the app restarted the task SLEEPS — no errors, no runs). kind "command": a workspace job — the ' +
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
            'note = data interpreted by the secretary; code = run(ctx) body from tasks/; command = a shell command run in the workspace file area.',
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
          description: `kind "command" only: kill timeout in milliseconds, ${JOB_TIMEOUT_MIN_MS}-${JOB_TIMEOUT_MAX_MS}. Null = default ${JOB_TIMEOUT_DEFAULT_MS} (10 minutes). On expiry the whole process group is killed and the run is journaled as "timeout".`,
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
      'whether a code task is sleeping (registered but without a body in the running bundle), and for ' +
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
      "task's body file in the repository is untouched (it just stops being scheduled).",
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

function isSleeping(task: ScheduledTaskModel): boolean {
  return task.kind === 'code' && !getTaskBody(task.slug);
}

async function createTask(args: JsonObject, ctx: BuiltinServerCallContext): Promise<string> {
  const slug = requireSlug(args);

  if (!SLUG_PATTERN.test(slug) || slug.length > SLUG_MAX_LENGTH) {
    throw new Error(`slug must match ${SLUG_PATTERN} and be at most ${SLUG_MAX_LENGTH} chars`);
  }

  const name = typeof args.name === 'string' ? args.name.trim() : '';

  if (!name) {
    throw new Error('a non-empty name is required');
  }

  const kind = args.kind;

  if (kind !== 'note' && kind !== 'code' && kind !== 'command') {
    throw new Error('kind must be "note", "code" or "command"');
  }

  const description = typeof args.description === 'string' && args.description.trim() ? args.description.trim() : null;
  const cron = typeof args.cron === 'string' && args.cron.trim() ? args.cron.trim() : null;
  const atRaw = typeof args.at === 'string' && args.at.trim() ? args.at.trim() : null;
  const note = typeof args.note === 'string' && args.note.trim() ? args.note.trim() : null;

  if (cron && atRaw) {
    throw new Error('cron and at are mutually exclusive — a task has at most one trigger');
  }

  if (kind === 'note' && !note) {
    throw new Error('kind "note" requires a non-empty note — it is the content the secretary will act on');
  }

  // The per-kind command fields: validated and stored only for kind
  // "command"; for other kinds a supplied value is rejected as confusion.
  const command = typeof args.command === 'string' && args.command.trim() ? args.command.trim() : null;
  const cwdRaw = typeof args.cwd === 'string' && args.cwd.trim() ? args.cwd.trim() : null;
  const timeoutRaw = typeof args.timeout_ms === 'number' ? args.timeout_ms : null;
  const reportOnSuccess = args.report_on_success === true;

  if (kind !== 'command' && (command || cwdRaw || timeoutRaw !== null || reportOnSuccess)) {
    throw new Error(`command, cwd, timeout_ms and report_on_success apply only to kind "command" — null them for kind "${kind}"`);
  }

  let cwd: string | null = null;
  let timeoutMs: number | null = null;

  if (kind === 'command') {
    if (!command) {
      throw new Error('kind "command" requires a non-empty command — it is what the trigger executes (bash -c)');
    }

    if (cwdRaw) {
      try {
        cwd = sanitizeRelPath(cwdRaw, 'cwd');
      } catch (error) {
        if (error instanceof WorkspacePathError) {
          throw new Error(error.message);
        }

        throw error;
      }
    }

    if (timeoutRaw !== null) {
      if (!Number.isInteger(timeoutRaw) || timeoutRaw < JOB_TIMEOUT_MIN_MS || timeoutRaw > JOB_TIMEOUT_MAX_MS) {
        throw new Error(
          `timeout_ms must be an integer between ${JOB_TIMEOUT_MIN_MS} and ${JOB_TIMEOUT_MAX_MS} (milliseconds), or null for the default ${JOB_TIMEOUT_DEFAULT_MS}`,
        );
      }

      timeoutMs = timeoutRaw;
    }
  }

  let firstFire: Date | null = null;

  if (cron) {
    try {
      assertValidCron(cron);
    } catch (error) {
      throw new Error(`invalid cron expression "${cron}": ${error instanceof Error ? error.message : String(error)}`);
    }

    firstFire = cronNextRun(cron, new Date());

    if (!firstFire) {
      throw new Error(`cron expression "${cron}" never yields a future moment`);
    }
  }

  let at: Date | null = null;

  if (atRaw) {
    if (!ISO_OFFSET_RE.test(atRaw)) {
      throw new Error('at must be an ISO 8601 instant with an explicit offset, e.g. "2026-08-09T09:00:00+03:00" or "...Z"');
    }

    at = new Date(atRaw);

    if (Number.isNaN(at.getTime())) {
      throw new Error(`at is not a valid ISO 8601 instant: "${atRaw}"`);
    }
  }

  const existing = await prisma.scheduledTask.findUnique({ where: { slug } });

  if (existing) {
    throw new Error(`slug "${slug}" is already taken — cancel_task it first to recreate`);
  }

  const thread = await getThread(ctx.threadId);

  const task = await prisma.scheduledTask.create({
    data: {
      slug,
      userId: ctx.userId,
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
      createdBy: thread?.agent ?? null,
    },
  });

  const lines = [`Task "${slug}" (${kind}) registered. Trigger: ${describeTrigger(task)}.`];

  if (at && at.getTime() <= Date.now()) {
    lines.push('The moment is already in the past — the task fires on the next heart pass and is consumed.');
  }

  if (kind === 'code') {
    if (isSleeping(task)) {
      lines.push(
        `The task SLEEPS: no run(ctx) body under slug "${slug}" in the running bundle. It comes alive after ` +
          `tasks/${slug}.ts is added to the tasks/ index, the app is rebuilt and restarted.`,
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
    where: { userId: ctx.userId },
    orderBy: { createdAt: 'asc' },
  });

  if (!tasks.length) {
    return 'No scheduled tasks registered.';
  }

  const lines = tasks.map(task => {
    const flags = [
      ...(isSleeping(task) ? ['SLEEPING — no body in the running bundle'] : []),
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

async function cancelTask(args: JsonObject, ctx: BuiltinServerCallContext): Promise<string> {
  const slug = requireSlug(args);
  const { count } = await prisma.scheduledTask.deleteMany({ where: { slug, userId: ctx.userId } });

  if (count === 0) {
    throw new Error(`no task with slug "${slug}" in this workspace`);
  }

  return `Task "${slug}" deleted; its trigger is disarmed.`;
}

async function runTask(args: JsonObject, ctx: BuiltinServerCallContext): Promise<string> {
  const slug = requireSlug(args);
  const task = await prisma.scheduledTask.findFirst({ where: { slug, userId: ctx.userId } });

  if (!task) {
    throw new Error(`no task with slug "${slug}" in this workspace`);
  }

  // The sleeping-task rule, synchronously: a body-less code task cannot run.
  if (isSleeping(task)) {
    throw new Error(
      `task "${slug}" is sleeping — its run(ctx) body is not in the running bundle. Build and restart first.`,
    );
  }

  const outcome = await fireTask(task, 'manual');

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
    case 'no_main_thread':
      throw new Error(`workspace has no main thread to fire into`);
    case 'sleeping':
      throw new Error(`task "${slug}" is sleeping — its body is not in the running bundle`);
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
      userId: ctx.userId,
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

  const run = await prisma.jobRun.findFirst({ where: { id: runId, userId: ctx.userId } });

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
