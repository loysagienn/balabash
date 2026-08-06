// Read side of the event log: consumer cursor reads and the transcript
// formula (§5.2): транскрипт(T) = events authored in T ∪ events addressed
// to T, in global seq order.

import { prisma } from '../db/client.ts';
import type { Event } from './contract.ts';
import { toEvent } from './envelope.ts';

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

type TranscriptOptions = {
  afterSeq?: bigint;
  limit?: number;
  // Return only the newest `last` events (still oldest-first) — the snapshot
  // shape run turns are built from.
  last?: number;
};

// The thread's transcript. Both sides of every inter-thread fact see it via
// this formula: the child authored it (threadId), the parent was addressed
// (targetThreadId) — each fact recorded exactly once.
export async function getTranscript(
  threadId: string,
  { afterSeq, limit, last }: TranscriptOptions = {},
): Promise<Event[]> {
  const where = {
    OR: [{ threadId }, { targetThreadId: threadId }],
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
