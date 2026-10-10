// The run journal of workspace jobs (job_runs) as the console reads it: the
// views of a row (contract: JobRunView, JobRunDetailView) and the reads —
// a page of runs newest first, one run in full, the newest run of every
// task. The journal is telemetry outside the event log (schema.prisma), so
// nothing here is an event: the api layer reads the table through these
// functions, the tools of src/schedule/tools.ts read it their own way for
// the model. Every read is scoped by the user: a run of another workspace
// is not found, not "forbidden".

import { Prisma } from '../../prisma-generated/client.ts';
import type { JobRunModel } from '../../prisma-generated/models.ts';
import { prisma } from '../db/client.ts';
import type { JobRunDetailView, JobRunStatus, JobRunView, JobTrigger } from '../api/contract.ts';

export const JOB_RUNS_PAGE_DEFAULT = 50;
export const JOB_RUNS_PAGE_MAX = 200;

// The columns of a row the lists carry — the tails stay behind.
const VIEW_SELECT = {
  id: true,
  slug: true,
  trigger: true,
  status: true,
  exitCode: true,
  startedAt: true,
  finishedAt: true,
  durationMs: true,
  stdoutTruncated: true,
  stderrTruncated: true,
} satisfies Prisma.JobRunSelect;

type ViewRow = Pick<JobRunModel, keyof typeof VIEW_SELECT>;

export function jobRunView(row: ViewRow): JobRunView {
  return {
    id: row.id,
    slug: row.slug,
    // The engine writes these closed sets (src/schedule/engine.ts); the
    // column is text, the view names the set.
    trigger: row.trigger as JobTrigger,
    status: row.status as JobRunStatus,
    exitCode: row.exitCode,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    durationMs: row.durationMs,
    stdoutTruncated: row.stdoutTruncated,
    stderrTruncated: row.stderrTruncated,
  };
}

export function jobRunDetailView(row: JobRunModel): JobRunDetailView {
  return {
    ...jobRunView(row),
    command: row.command,
    cwd: row.cwd,
    stdoutTail: row.stdoutTail,
    stderrTail: row.stderrTail,
  };
}

export type JobRunsPage = { runs: JobRunView[]; nextCursor: string | null };

// A page of runs newest first, optionally of one task; `before` — the id of
// a run: the page holds the runs started before it (a keyset on startedAt
// and id, so two runs started in the same millisecond never lose one
// between pages). A cursor naming no run of the user reads as the end: an
// empty page — the journal does not keep what it never had.
export async function listJobRuns(userId: string, options: { slug?: string; before?: string; limit: number }): Promise<JobRunsPage> {
  let cursor: { startedAt: Date; id: string } | null = null;

  if (options.before !== undefined) {
    cursor = await prisma.jobRun.findFirst({ where: { id: options.before, userId }, select: { startedAt: true, id: true } });

    if (!cursor) {
      return { runs: [], nextCursor: null };
    }
  }

  const rows = await prisma.jobRun.findMany({
    where: {
      userId,
      ...(options.slug !== undefined ? { slug: options.slug } : {}),
      ...(cursor
        ? {
            OR: [{ startedAt: { lt: cursor.startedAt } }, { startedAt: cursor.startedAt, id: { lt: cursor.id } }],
          }
        : {}),
    },
    orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
    take: options.limit + 1,
    select: VIEW_SELECT,
  });

  const page = rows.slice(0, options.limit);

  return { runs: page.map(jobRunView), nextCursor: rows.length > options.limit ? page[page.length - 1]!.id : null };
}

export async function getJobRun(userId: string, id: string): Promise<JobRunDetailView | null> {
  const row = await prisma.jobRun.findFirst({ where: { id, userId } });

  return row ? jobRunDetailView(row) : null;
}

// The newest run of every task that has one, newest first across tasks.
// One query: DISTINCT ON (slug) over the (slug, started_at) index — the
// journal of a workspace holds thousands of rows, the answer a dozen.
export async function latestJobRuns(userId: string): Promise<JobRunView[]> {
  const rows = await prisma.$queryRaw<ViewRow[]>`
    SELECT DISTINCT ON (slug)
      id, slug, trigger, status, exit_code AS "exitCode", started_at AS "startedAt", finished_at AS "finishedAt",
      duration_ms AS "durationMs", stdout_truncated AS "stdoutTruncated", stderr_truncated AS "stderrTruncated"
    FROM job_runs
    WHERE user_id = ${userId}
    ORDER BY slug, started_at DESC, id DESC
  `;

  return rows.map(jobRunView).sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime() || (a.id < b.id ? 1 : -1));
}
