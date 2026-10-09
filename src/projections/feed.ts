// Which thread's feed an event belongs to — the transcript formula of the
// core (authored in the thread OR addressed to it), as one predicate the
// server's queries and the console's feed reducer agree on.

import type { Event } from '../core/contract.ts';

type Addressed = Pick<Event, 'threadId' | 'targetThreadId'>;

export function feedScope(event: Addressed, threadId: string): boolean {
  return event.threadId === threadId || event.targetThreadId === threadId;
}

// Every thread an event shows up in: the author's and the addressee's.
export function feedThreadIds(event: Addressed): string[] {
  const ids: string[] = [];

  if (event.threadId) {
    ids.push(event.threadId);
  }

  if (event.targetThreadId && event.targetThreadId !== event.threadId) {
    ids.push(event.targetThreadId);
  }

  return ids;
}
