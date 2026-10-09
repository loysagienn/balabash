// The numbers of the status segments and of the subtitle of the Threads
// screen: the active ones are the store's (the snapshot holds every active
// thread; the main thread is not counted), the closed ones the server's
// counts of the set, brought by the first page; "All" is their sum.
// Undefined while the first page of the set has not landed.

import type { ThreadCounts, ThreadStatus } from '../../../core/contract.ts';

export function segmentCount(status: ThreadStatus | undefined, counts: ThreadCounts | null, active: number): number | undefined {
  if (status === 'active') {
    return active;
  }

  if (!counts) {
    return undefined;
  }

  return status === undefined ? active + counts.completed + counts.failed + counts.cancelled : counts[status];
}
