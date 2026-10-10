// The whole count of a set of threads — an agent's or a project's, all time
// or the recent window — read by place from the first page of GET /threads:
// its `counts` are the set's numbers by status, stamped with the log
// position they are exact at (frontend.md, "Второй слой данных"). The store
// holds only a window of threads, so the number comes from the server; the
// tail brings it up to date — a thread of the set started above the stamp
// is counted here; a request that failed is named with its retry. Pure,
// tested.

import type { Thread, ThreadCounts } from '../../../core/contract.ts';

export const RECENT_DAYS = 30;

export type ThreadTotal = { total: number; asOfSeq: bigint | null };

// The sum of a page's counts with the stamp they are exact at; null when
// the page brought none (only a first page does).
export function totalOf(page: { counts?: ThreadCounts; countsAsOfSeq?: bigint }): ThreadTotal | null {
  if (!page.counts) {
    return null;
  }

  const { active, completed, failed, cancelled } = page.counts;

  return { total: active + completed + failed + cancelled, asOfSeq: page.countsAsOfSeq ?? null };
}

// The total brought up to the store: among the set's threads the store
// knows (the caller's selection — the agent's, the project's), one created
// above the stamp was started after the count and adds one; with `since`
// only one created at or after it counts, the window's own rule. Without a
// stamp the server's number stands.
export function totalWithTail(total: ThreadTotal, threads: readonly Pick<Thread, 'createdSeq' | 'createdAt'>[], since?: Date): number {
  if (total.asOfSeq === null) {
    return total.total;
  }

  let n = total.total;

  for (const thread of threads) {
    if (thread.createdSeq > total.asOfSeq && (since === undefined || thread.createdAt >= since)) {
      n += 1;
    }
  }

  return n;
}

// What a screen sees of the count's request (a Query result): the total
// read off the page, and whether the request stands in error.
export type TotalResult = { data: ThreadTotal | null | undefined; isError: boolean };

// The total a screen may show: the request's answer brought up to the tail,
// none while the request stands in error. Query keeps the data of an earlier
// answer through a failed refetch — a number from before the failure would
// pass for current, and "No threads yet" or "7 threads" on it would be a
// claim no one can back; the failure is named beside with its Retry.
export function knownTotal(query: TotalResult, threads: readonly Pick<Thread, 'createdSeq' | 'createdAt'>[], since?: Date): number | null {
  return query.isError || !query.data ? null : totalWithTail(query.data, threads, since);
}

const HOUR = 3_600_000;

// The start of the recent window: RECENT_DAYS back, at the hour — so the
// query key holds still across renders and minutes, and the window moves
// (and is requested again) once an hour at most. The hour is the epoch's
// (UTC), not the local clock's: a local setter would read a moment inside
// the repeated hour of a DST fall-back as the first of the two and move the
// start a whole hour further back — the boundary is a server filter, no one
// reads it as a local time.
export function recentSince(now: Date): Date {
  return new Date(Math.floor((now.getTime() - RECENT_DAYS * 86_400_000) / HOUR) * HOUR);
}

// What a consumer sees of a request of the count (a Query result).
export type TotalQuery = { isError: boolean; error: Error | null; isFetching: boolean; refetch: () => Promise<unknown> };

export type TotalFailure = { message: string; pending: boolean; retry: () => void };

// The failure of a set's requests, when one of them ended in one: the first
// error's words (there is one line's room), whether a new attempt is in
// flight, and the retry — of the requests that failed, not of those that
// answered. A failed count must not look like one still loading.
export function failureOf(queries: readonly TotalQuery[]): TotalFailure | null {
  const failed = queries.filter(query => query.isError);

  if (failed.length === 0) {
    return null;
  }

  return {
    message: failed[0].error?.message ?? 'request failed',
    pending: failed.some(query => query.isFetching),
    retry: () => {
      for (const query of failed) {
        void query.refetch();
      }
    },
  };
}
