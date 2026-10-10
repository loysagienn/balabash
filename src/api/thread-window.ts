// The threads of the snapshot: every active thread of the workspace (the
// console counts its Active numbers from the store, so the window holds
// them all — read in pages until a page comes back short), the newest
// SNAPSHOT_THREAD_WINDOW threads of any status, the main thread by id —
// pinned above the Threads list whatever its age — and the thread that
// ended last (the greatest terminal seq — Home says when the last thread
// finished, and an old thread may be the one that finished last). The
// last two are guarantees of the snapshot, not properties of the limits:
// the pages usually bring them (the main thread is active, the last
// terminal is usually recent), the lookups cover the case they would not.
// Older history pages in through GET /api/threads. Pure over injected
// reads: the limits and the guarantees are tested without a database.

import type { Thread, ThreadStatus } from '../core/contract.ts';

export const SNAPSHOT_THREAD_WINDOW = 200;
// One page of the active threads.
export const ACTIVE_PAGE = 500;

export type ThreadWindowReads = {
  list(userId: string, options: { status?: ThreadStatus; beforeCreatedSeq?: bigint; limit: number; order: 'desc' }): Promise<Thread[]>;
  get(id: string): Promise<Thread | null>;
  // The workspace's thread with the greatest terminal seq; null while none has ended.
  latestTerminal(userId: string): Promise<Thread | null>;
};

const newestFirst = (a: Thread, b: Thread) => (a.createdSeq > b.createdSeq ? -1 : a.createdSeq < b.createdSeq ? 1 : 0);

export async function readThreadWindow(userId: string, mainThreadId: string | null, reads: ThreadWindowReads): Promise<Thread[]> {
  const byId = new Map<string, Thread>();
  const take = (threads: Thread[]) => {
    for (const thread of threads) {
      byId.set(thread.id, thread);
    }
  };
  const newest = reads.list(userId, { limit: SNAPSHOT_THREAD_WINDOW, order: 'desc' });
  const latestTerminal = reads.latestTerminal(userId);

  for (let before: bigint | undefined; ; ) {
    const page = await reads.list(userId, { status: 'active', ...(before !== undefined ? { beforeCreatedSeq: before } : {}), limit: ACTIVE_PAGE, order: 'desc' });

    take(page);

    if (page.length < ACTIVE_PAGE) {
      break;
    }

    before = page[page.length - 1]!.createdSeq;
  }

  take(await newest);

  if (mainThreadId !== null && !byId.has(mainThreadId)) {
    const main = await reads.get(mainThreadId);

    if (main) {
      byId.set(main.id, main);
    }
  }

  const ended = await latestTerminal;

  if (ended && !byId.has(ended.id)) {
    byId.set(ended.id, ended);
  }

  return [...byId.values()].sort(newestFirst);
}
