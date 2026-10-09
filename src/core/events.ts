// Read side of the event log: consumer cursor reads and the transcript
// formula (§5.2): транскрипт(T) = events authored in T ∪ events addressed
// to T, in global seq order.

import { prisma } from '../db/client.ts';
import { createLiveHub, installLiveHub } from './live.ts';
import type { Event } from './contract.ts';
import { SESSION_EVENT_PREFIX, toEvent } from './envelope.ts';

type GetEventsAfterOptions = {
  types?: string[];
  limit?: number;
};

// Cursor read for consumers: events strictly after `afterSeq`, oldest first.
export async function getEventsAfter(
  afterSeq: bigint,
  { types, limit = 100 }: GetEventsAfterOptions = {},
): Promise<Event[]> {
  const rows = await prisma.event.findMany({
    where: {
      seq: { gt: afterSeq },
      ...(types !== undefined ? { type: { in: types } } : {}),
    },
    orderBy: { seq: 'asc' },
    take: limit,
  });

  return rows.map(toEvent);
}

// The newest seq of one event type, log-wide; null when none was ever
// written. Lets a consumer tell a stale fact from a live one (restart module).
export async function getLastEventSeq(type: string): Promise<bigint | null> {
  const row = await prisma.event.findFirst({
    where: { type },
    orderBy: { seq: 'desc' },
    select: { seq: true },
  });

  return row?.seq ?? null;
}

// Seconds since the last event was appended, by the database clock; null on
// an empty log. The restart module's quiet-window buffer reads this.
export async function getLogQuietSeconds(): Promise<number | null> {
  const rows = await prisma.$queryRaw<Array<{ quiet: number | null }>>`
    SELECT EXTRACT(EPOCH FROM (now() - max(created_at)))::float8 AS quiet FROM events`;

  return rows[0]?.quiet ?? null;
}

type TranscriptOptions = {
  afterSeq?: bigint;
  limit?: number;
  // Return only the newest `last` events (still oldest-first) — the snapshot
  // shape run turns are built from.
  last?: number;
};

// The thread's transcript. Both sides of every inter-thread fact see it via
// this formula: the child authored it (threadId), the parent was addressed
// (targetThreadId) — each fact recorded exactly once. The session journal
// (session.*) is not part of it: a transcript is what a model reads of a
// thread, and the inner course of an SDK session is that session's own
// memory — it would only crowd the window (the console reads it through
// listThreadEvents).
export async function getTranscript(
  threadId: string,
  { afterSeq, limit, last }: TranscriptOptions = {},
): Promise<Event[]> {
  const where = {
    OR: [{ threadId }, { targetThreadId: threadId }],
    NOT: { type: { startsWith: SESSION_EVENT_PREFIX } },
    ...(afterSeq !== undefined ? { seq: { gt: afterSeq } } : {}),
  };

  if (last !== undefined) {
    const rows = await prisma.event.findMany({
      where,
      orderBy: { seq: 'desc' },
      take: last,
    });

    return rows.reverse().map(toEvent);
  }

  const rows = await prisma.event.findMany({
    where,
    orderBy: { seq: 'asc' },
    ...(limit !== undefined ? { take: limit } : {}),
  });

  return rows.map(toEvent);
}

type ListThreadEventsOptions = {
  // Older than seq, newest first (history paging).
  beforeSeq?: bigint;
  // Newer than seq, OLDEST first (the live tail of a chat). Exclusive with
  // beforeSeq.
  afterSeq?: bigint;
  limit?: number;
};

// The web window's feed: the same WHERE as the transcript formula (authored
// in the thread OR addressed to it), but the events come WHOLE — payload as
// stored, nothing prepared or trimmed for a model context. Newest first,
// cursor-paginated by the global seq: pass the smallest seen seq as
// beforeSeq to continue into older events. seq is unique and follows insert
// order, so equal createdAt timestamps still page deterministically — no
// duplicates, no gaps at page boundaries.
export async function listThreadEvents(
  threadId: string,
  { beforeSeq, afterSeq, limit = 100 }: ListThreadEventsOptions = {},
): Promise<Event[]> {
  const rows = await prisma.event.findMany({
    where: {
      OR: [{ threadId }, { targetThreadId: threadId }],
      ...(beforeSeq !== undefined ? { seq: { lt: beforeSeq } } : {}),
      ...(afterSeq !== undefined ? { seq: { gt: afterSeq } } : {}),
    },
    orderBy: { seq: afterSeq !== undefined ? 'asc' : 'desc' },
    take: limit,
  });

  return rows.map(toEvent);
}

// Recall for the pull tools (§5.2): one event by global seq, visible only
// inside its own workspace.
export async function getUserEvent(userId: string, seq: bigint): Promise<Event | null> {
  const row = await prisma.event.findFirst({ where: { userId, seq } });

  return row ? toEvent(row) : null;
}

type GetUserEventsOptions = {
  beforeSeq?: bigint;
  limit?: number;
};

// Paginated feed for the web UI: the workspace's events, newest first.
export async function getUserEvents(
  userId: string,
  { beforeSeq, limit = 50 }: GetUserEventsOptions = {},
): Promise<Event[]> {
  const rows = await prisma.event.findMany({
    where: {
      userId,
      ...(beforeSeq !== undefined ? { seq: { lt: beforeSeq } } : {}),
    },
    orderBy: { seq: 'desc' },
    take: limit,
  });

  return rows.map(toEvent);
}

// The live tail over the real log (src/core/live.ts): one hub per process,
// reading with the cursor reads above. Installed here, not in live.ts, so
// append.ts → live.ts never pulls the database module into a cycle.
installLiveHub(() =>
  createLiveHub({
    readAfter: (seq, limit) => getEventsAfter(seq, { limit }),
    headSeq: async () => {
      const { _max } = await prisma.event.aggregate({ _max: { seq: true } });

      return _max.seq ?? 0n;
    },
  }),
);
