// System's second-layer data (frontend.md, "Второй слой данных"): the main
// thread's window of model requests — rows of llm_requests, which are not
// events of the log, so the card reads them when opened and on "Refresh";
// and the older pages of the system's own events for "Show more" — the
// store holds the newest KEEP (store/system), the pages before them come
// from GET /api/system/log as the operator asks for more.

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { SystemLogKind } from '../../../api/contract.ts';
import { useApi } from '../../lib/api/context.tsx';
import { retryUnlessClient } from '../../lib/api/retry.ts';
import { TOKEN_WINDOW } from './SystemScreen.logic.ts';

export function useThreadRequests(threadId: string | null) {
  const api = useApi();

  return useQuery({
    queryKey: ['llm-requests', threadId, TOKEN_WINDOW],
    queryFn: ({ signal }) => api.llmRequests.list({ threadId: threadId ?? undefined, limit: TOKEN_WINDOW }, signal),
    enabled: threadId !== null,
    retry: retryUnlessClient,
  });
}

// A card shows this many rows at first and adds as many per "Show more".
export const LOG_PAGE = 5;

// The pages of the log before `before` (the oldest seq the store held when
// the card opened; null — the store held none, so the newest page), of one
// kind (none — every kind): the first page is read at once — it carries
// the count the caption needs — the next ones on demand. Each page's oldest
// seq is the next page's `before`; a short page is the last.
export function useOlderSystemLog(kind: SystemLogKind | undefined, before: bigint | null) {
  const api = useApi();

  return useInfiniteQuery({
    queryKey: ['system-log', kind ?? 'all', before === null ? null : String(before)],
    initialPageParam: before,
    queryFn: ({ pageParam, signal }) => api.system.log({ kind, before: pageParam === null ? undefined : String(pageParam), limit: LOG_PAGE }, signal),
    getNextPageParam: (last): bigint | null | undefined => (last.events.length < LOG_PAGE ? undefined : last.events[0]!.seq),
    retry: retryUnlessClient,
  });
}
