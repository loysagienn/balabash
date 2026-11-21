// The journal of scheduled runs as the scheme of capabilities reads it: a
// page of runs newest first and one run whole. Every read is scoped by the
// workspace: a run of another workspace is not found, not "forbidden".
//
// A run is a row of ScheduleRun. The history of a workspace also holds the
// runs of its former workspace jobs (JobRun, the former kind 'command'), and
// a reader sees both as one journal: a job's run is read as the run of the
// program its task turns into — one call of `workspace_run_command` — with
// the exit of the command as the outcome and its output as the console.
// formerRunData() below is that reading, and the only place that knows the
// former form; the move of the journal writes the same into ScheduleRun,
// after which the former half of every read here goes away.

import type { JobRunModel, ScheduleRunModel } from '../../prisma-generated/models.ts';
import type { Prisma } from '../../prisma-generated/client.ts';
import { consoleTail } from '../catalog/index.ts';
import type { JsonValue } from '../core/contract.ts';
import { prisma } from '../db/client.ts';
import type { RunRecord, RunStatus, RunSummary, RunTrigger } from './run-record.ts';

export const RUN_STATUSES: readonly RunStatus[] = ['running', 'ok', 'failed', 'timeout', 'aborted'];

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

// The error of a run as its reader gets it. The details are a part of it: a
// command that failed says how in its details (the exit code, the output),
// and a program that did not catch the error wrote none of that anywhere
// else.
function errorText(error: { kind?: unknown; message?: unknown; details?: unknown }): string {
  const said = `${String(error.kind)}: ${String(error.message)}`;

  return error.details === undefined || error.details === null ? said : `${said}\nDetails: ${JSON.stringify(error.details)}`;
}

function programRun(row: ScheduleRunModel): RunRecord {
  const error = row.error as { kind?: unknown; message?: unknown; details?: unknown } | null;

  return {
    ...summary(row, row.hasValue),
    code: row.code,
    value: row.hasValue ? (row.value as JsonValue) : null,
    error: (row.status === 'failed' || row.status === 'timeout') && error ? errorText(error) : null,
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

function formerErrorMessage(row: JobRunModel): string | null {
  switch (row.status) {
    case 'failed':
      return `The command exited with code ${row.exitCode ?? 'unknown'}.`;
    case 'timeout':
      return 'The command ran longer than its limit and was killed.';
    case 'spawn_error':
      return `The command could not be started: ${row.stderrTail || 'spawn error'}`;
    default:
      return null;
  }
}

// The console of a job is the ends of its two streams, one after the other,
// kept by the limit of a run's console like any other.
export function formerRunData(row: JobRunModel): ScheduleRunModel {
  const input = { command: row.command, ...(row.cwd ? { cwd: row.cwd } : {}) };
  const between = row.stdoutTail && row.stderrTail && !row.stdoutTail.endsWith('\n') ? '\n' : '';
  const output = consoleTail(`${row.stdoutTail}${between}${row.stderrTail}`);
  const message = formerErrorMessage(row);

  return {
    id: row.id,
    workspaceId: row.workspaceId,
    slug: row.slug,
    trigger: row.trigger,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    durationMs: row.durationMs,
    status: formerStatus(row.status),
    hasValue: false,
    code: `await call('workspace_run_command', ${JSON.stringify(input)});\nreturn null;`,
    value: null,
    error: message ? { kind: 'external_error', message } : null,
    console: output.text,
    consoleTruncated: output.truncated || row.stdoutTruncated || row.stderrTruncated,
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

  return former ? programRun(formerRunData(former)) : null;
}

// The console's page cursor is a run id. Look up its position without
// loading the program or its output.
export async function findRunPosition(workspaceId: string, id: string): Promise<RunPosition | null> {
  const query = { where: { workspaceId, id }, select: { id: true, startedAt: true } };
  return (await prisma.scheduleRun.findFirst(query)) ?? prisma.jobRun.findFirst(query);
}

// The task list needs one summary per slug, including tasks whose most
// recent run is in the former journal. Keep the reduction in the database.
export async function latestRuns(workspaceId: string): Promise<RunSummary[]> {
  const rows = await prisma.$queryRaw<(SummaryRow & { hasValue: boolean })[]>`
    SELECT DISTINCT ON (slug) id, slug, trigger, status, started_at AS "startedAt",
      finished_at AS "finishedAt", duration_ms AS "durationMs", has_value AS "hasValue"
    FROM (
      SELECT id, slug, trigger, status, started_at, finished_at, duration_ms, has_value
      FROM schedule_runs WHERE workspace_id = ${workspaceId}
      UNION ALL
      SELECT id, slug, trigger, status, started_at, finished_at, duration_ms, false
      FROM job_runs WHERE workspace_id = ${workspaceId}
    ) AS history
    ORDER BY slug, started_at DESC, id DESC
  `;

  return rows.map(row => summary({ ...row, status: formerStatus(row.status) }, row.hasValue)).sort(newestFirst);
}
