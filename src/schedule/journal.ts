// The journal of scheduled runs as the scheme of capabilities reads it: a
// page of runs newest first and one run whole. Every read is scoped by the
// workspace: a run of another workspace is not found, not "forbidden".
//
// A run is a row of ScheduleRun. The history of a workspace also holds the
// runs of its former workspace jobs (JobRun, the former kind 'command'), and
// a reader sees both as one journal: a job's run is read as the run of the
// program its task turns into — one call of `workspace_run_command` — with
// the exit of the command as the outcome and its output as the console.
// formerRun() below is that reading, and the only place that knows the
// former form; the move of the journal writes the same into ScheduleRun,
// after which the former half of every read here goes away.

import type { JobRunModel, ScheduleRunModel } from '../../prisma-generated/models.ts';
import type { Prisma } from '../../prisma-generated/client.ts';
import type { JsonValue } from '../core/contract.ts';
import { prisma } from '../db/client.ts';
import type { RunTrigger } from './engine.ts';

export type RunStatus = 'running' | 'ok' | 'failed' | 'timeout' | 'aborted';

export const RUN_STATUSES: readonly RunStatus[] = ['running', 'ok', 'failed', 'timeout', 'aborted'];

// A run as a list carries it: without its code, its value and its console.
export type RunSummary = {
  id: string;
  // The slug of the task as it was at fire time.
  slug: string;
  trigger: RunTrigger;
  status: RunStatus;
  startedAt: Date;
  finishedAt: Date | null;
  durationMs: number | null;
  // The run returned a value other than null.
  hasValue: boolean;
};

export type RunRecord = RunSummary & {
  code: string;
  value: JsonValue | null;
  // What ended a failed or timed-out run.
  error: string | null;
  console: string;
  consoleTruncated: boolean;
};

// Where a page ends and the next one starts: the journal is ordered by the
// start of a run, the id tells apart two runs started in one millisecond.
export type RunPosition = { startedAt: Date; id: string };

const SUMMARY = {
  id: true,
  slug: true,
  trigger: true,
  status: true,
  startedAt: true,
  finishedAt: true,
  durationMs: true,
} as const;

type SummaryRow = Pick<ScheduleRunModel, keyof typeof SUMMARY>;

function summary(row: SummaryRow, hasValue: boolean): RunSummary {
  return {
    id: row.id,
    slug: row.slug,
    // The schedule writes these closed sets; the columns are text.
    trigger: row.trigger as RunTrigger,
    status: row.status as RunStatus,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    durationMs: row.durationMs,
    hasValue,
  };
}

function programRun(row: ScheduleRunModel): RunRecord {
  const error = row.error as { kind?: unknown; message?: unknown } | null;

  return {
    ...summary(row, row.hasValue),
    code: row.code,
    value: row.hasValue ? (row.value as JsonValue) : null,
    error: (row.status === 'failed' || row.status === 'timeout') && error ? `${String(error.kind)}: ${String(error.message)}` : null,
    console: row.console,
    consoleTruncated: row.consoleTruncated,
  };
}

// --- The former half: the runs of workspace jobs --------------------------

// A job that could not be started has failed like any other.
function formerStatus(status: string): RunStatus {
  return status === 'spawn_error' ? 'failed' : (status as RunStatus);
}

function formerSummary(row: Pick<JobRunModel, keyof typeof SUMMARY>): RunSummary {
  return { ...summary(row, false), status: formerStatus(row.status) };
}

function formerError(row: JobRunModel): string | null {
  switch (row.status) {
    case 'failed':
      return `external_error: The command exited with code ${row.exitCode ?? 'unknown'}.`;
    case 'timeout':
      return 'external_error: The command ran longer than its limit and was killed.';
    case 'spawn_error':
      return `external_error: The command could not be started: ${row.stderrTail || 'spawn error'}`;
    default:
      return null;
  }
}

function formerRun(row: JobRunModel): RunRecord {
  const input = { command: row.command, ...(row.cwd ? { cwd: row.cwd } : {}) };
  const between = row.stdoutTail && row.stderrTail && !row.stdoutTail.endsWith('\n') ? '\n' : '';

  return {
    ...formerSummary(row),
    code: `await call('workspace_run_command', ${JSON.stringify(input)});\nreturn null;`,
    value: null,
    error: formerError(row),
    console: `${row.stdoutTail}${between}${row.stderrTail}`,
    consoleTruncated: row.stdoutTruncated || row.stderrTruncated,
  };
}

function formerStatuses(status: RunStatus): string[] {
  return status === 'failed' ? ['failed', 'spawn_error'] : [status];
}

// --- The reads -------------------------------------------------------------

export type RunsFilter = {
  slug?: string;
  status?: RunStatus;
  hasValue?: boolean;
  limit: number;
  // The runs started before this position.
  before?: RunPosition;
};

export type RunsPage = { runs: RunSummary[]; next: RunPosition | null };

function newestFirst(a: RunSummary, b: RunSummary): number {
  return b.startedAt.getTime() - a.startedAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}

// A page of runs newest first. Each half of the journal gives its own top of
// the page from the same position; the page is the top of the two together.
export async function listRuns(workspaceId: string, filter: RunsFilter): Promise<RunsPage> {
  const { before, limit } = filter;
  const place = {
    workspaceId,
    ...(filter.slug !== undefined ? { slug: filter.slug } : {}),
    ...(before ? { OR: [{ startedAt: { lt: before.startedAt } }, { startedAt: before.startedAt, id: { lt: before.id } }] } : {}),
  };
  const order = [{ startedAt: 'desc' }, { id: 'desc' }] satisfies Prisma.ScheduleRunOrderByWithRelationInput[];

  const [programs, former] = await Promise.all([
    prisma.scheduleRun.findMany({
      where: {
        ...place,
        ...(filter.status !== undefined ? { status: filter.status } : {}),
        ...(filter.hasValue !== undefined ? { hasValue: filter.hasValue } : {}),
      },
      orderBy: order,
      take: limit + 1,
      select: { ...SUMMARY, hasValue: true },
    }),
    // A job never returned a value.
    filter.hasValue === true
      ? []
      : prisma.jobRun.findMany({
          where: { ...place, ...(filter.status !== undefined ? { status: { in: formerStatuses(filter.status) } } : {}) },
          orderBy: order,
          take: limit + 1,
          select: SUMMARY,
        }),
  ]);

  const runs = [...programs.map(row => summary(row, row.hasValue)), ...former.map(formerSummary)].sort(newestFirst);
  const page = runs.slice(0, limit);
  const last = page[page.length - 1];

  return { runs: page, next: runs.length > limit && last ? { startedAt: last.startedAt, id: last.id } : null };
}

export async function getRun(workspaceId: string, id: string): Promise<RunRecord | null> {
  const row = await prisma.scheduleRun.findFirst({ where: { id, workspaceId } });

  if (row) {
    return programRun(row);
  }

  const former = await prisma.jobRun.findFirst({ where: { id, workspaceId } });

  return former ? formerRun(former) : null;
}
