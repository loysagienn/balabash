// The whole count of a set of threads — an agent's or a project's, all time
// or the recent window — read by place from the first page of GET /threads:
// its `counts` are the set's numbers by status, stamped with the log
// position they are exact at (frontend.md, "Второй слой данных"). The store
// holds only a window of threads, so the number comes from the server; the
// tail brings it up to date — a thread of the set started above the stamp
// is counted here. Pure, tested.

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

// The start of the recent window: RECENT_DAYS back, at the hour — so the
// query key holds still across renders and minutes, and the window moves
// (and is requested again) once an hour at most.
export function recentSince(now: Date): Date {
  const since = new Date(now.getTime() - RECENT_DAYS * 86_400_000);

  since.setMinutes(0, 0, 0);

  return since;
}
