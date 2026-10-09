// Threads grouped by the local day they started, newest day first, each
// group with its divider label ("Today, October 9") and count.

import type { Thread } from '../../../core/contract.ts';
import { dayKey, dayLabel } from '../../lib/format/index.ts';

export type ThreadGroup = { key: string; label: string; threads: Thread[] };

// threads — already newest first.
export function groupByDay(threads: readonly Thread[], now: Date): ThreadGroup[] {
  const groups: ThreadGroup[] = [];
  let current: ThreadGroup | null = null;

  for (const thread of threads) {
    const key = dayKey(thread.createdAt);

    if (!current || current.key !== key) {
      current = { key, label: dayLabel(thread.createdAt, now), threads: [] };
      groups.push(current);
    }

    current.threads.push(thread);
  }

  return groups;
}
