// The whole count of a set of threads by place (frontend.md, "Второй слой
// данных"): the first page of GET /threads brings the set's `counts`, so a
// page of one row is the request — the Agents and Project screens put
// "N threads" beside the window of threads the store holds. The total is
// read off the page (totals.ts) and brought up to the store by the caller.

import { useQuery } from '@tanstack/react-query';
import type { ThreadsQuery } from '../../../api/contract.ts';
import { useApi } from '../../lib/api/context.tsx';
import { retryUnlessClient } from '../../lib/api/retry.ts';
import { totalOf } from './totals.ts';

// The set: an agent's threads, a project's, from a moment on (ISO).
export type ThreadSet = Pick<ThreadsQuery, 'agent' | 'projectId' | 'createdAtGte'>;

export function useThreadTotal(set: ThreadSet, enabled = true) {
  const api = useApi();

  return useQuery({
    queryKey: ['thread-total', set.agent ?? null, set.projectId ?? null, set.createdAtGte ?? null],
    queryFn: ({ signal }) => api.threads.list({ ...set, limit: 1 }, signal),
    select: totalOf,
    enabled,
    retry: retryUnlessClient,
  });
}
