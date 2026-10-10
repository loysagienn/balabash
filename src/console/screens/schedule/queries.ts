// The run journal by place (frontend.md, "Второй слой данных"): the runs
// of one task or of all (a page newest first on a cursor, further pages on
// demand), the newest run of every task (the "last run" of the rows), one
// run with its output. The journal is telemetry outside the log — no event
// carries a run — so the lists refetch on their own: every few seconds
// while a run they show is still going (its end writes no event when it
// succeeds silently), once a minute otherwise, and on the tab's return;
// the store's stamp of the journal (a manual run accepted, a job that
// reported through the log) invalidates them all at once
// (lib/query/schedule.ts, the JOB_RUNS_KEY prefix).

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { JobRunsResponse } from '../../../api/contract.ts';
import { useApi } from '../../lib/api/context.tsx';
import { retryUnlessClient } from '../../lib/api/retry.ts';
import { JOB_RUNS_KEY } from '../../lib/query/schedule.ts';
import { anyRunning } from './ScheduleScreen.logic.ts';

export { JOB_RUNS_KEY };

export const RUNNING_POLL_MS = 5_000;
export const IDLE_POLL_MS = 60_000;

const pollEvery = (running: boolean) => (running ? RUNNING_POLL_MS : IDLE_POLL_MS);

export function useJobRuns(slug: string | undefined, limit: number) {
  const api = useApi();

  return useInfiniteQuery({
    queryKey: [...JOB_RUNS_KEY, 'list', slug ?? null, limit],
    queryFn: ({ pageParam, signal }) => api.schedule.runs({ slug, before: pageParam ?? undefined, limit }, signal),
    initialPageParam: null as string | null,
    getNextPageParam: (last: JobRunsResponse) => last.nextCursor,
    retry: retryUnlessClient,
    refetchInterval: query => pollEvery(anyRunning(query.state.data?.pages[0]?.runs ?? [])),
  });
}

export function useLatestJobRuns(enabled = true) {
  const api = useApi();

  return useQuery({
    queryKey: [...JOB_RUNS_KEY, 'latest'],
    queryFn: ({ signal }) => api.schedule.latestRuns(signal),
    select: response => response.runs,
    enabled,
    retry: retryUnlessClient,
    refetchInterval: query => pollEvery(anyRunning(query.state.data?.runs ?? [])),
  });
}

// One run whole: its output is written when the run ends, so a run still
// going is read again every few seconds; a settled run never changes.
export function useJobRun(id: string) {
  const api = useApi();

  return useQuery({
    queryKey: [...JOB_RUNS_KEY, 'run', id],
    queryFn: ({ signal }) => api.schedule.run(id, signal),
    select: response => response.run,
    retry: retryUnlessClient,
    staleTime: query => (query.state.data?.run.status === 'running' ? 0 : Infinity),
    refetchInterval: query => (query.state.data?.run.status === 'running' ? RUNNING_POLL_MS : false),
  });
}
