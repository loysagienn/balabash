// The rows of remote_threads — the whole state of a remote thread (the
// session's reference, the driver's cursor, the engine's watch) — and the
// one write that advances them: the mirror events of a read and the row's
// new position commit in ONE log transaction (logTransaction: the log lock
// first, then the events, then the row), so a crash between them repeats
// the read instead of skipping or doubling it; the live tail is told after
// the commit (notifyAppended), as a registry mutation does.

import { Prisma } from '../../prisma-generated/client.ts';
import type { RemoteThreadModel } from '../../prisma-generated/models.ts';
import { prisma } from '../db/client.ts';
import { appendEventIn, logTransaction } from '../core/append.ts';
import type { AppendInput } from '../core/envelope.ts';
import type { Event, JsonValue, NotificationLevel } from '../core/contract.ts';
import { THREAD_DECIDE, THREAD_FINISH, THREAD_MESSAGE, THREAD_PAUSE, toEvent } from '../core/envelope.ts';
import { notifyAppended } from '../core/live.ts';
import type { SessionState } from '../projections/session.ts';

// working — a turn is in flight; idle — the session waits; asking — a
// question waits for a human; paused — idle long enough (or by hand);
// finishing — the closing summary was asked for; closed — the thread is
// over; gone — the session is irrecoverably lost (the thread failed).
export type RemotePhase = 'working' | 'idle' | 'asking' | 'paused' | 'finishing' | 'closed' | 'gone';

export type OpenAsk = { askId: string; kind: 'approval' | 'credential' | 'other'; options: string[] };

// The engine's memory of the mirror, kept in the row (opaque JSON):
// everything a read needs to be applied idempotently and a restart must
// not forget.
export type WatchState = {
  headless: boolean;
  parentId: string;
  notification: NotificationLevel;
  // Our own prompts' ids (the opening prompt, every say): their echo is not
  // mirrored. Bounded — the newest OWN_IDS_KEEP.
  ownMessageIds: string[];
  openAsks: OpenAsk[];
  // Asks decided from Balabash: agent.ask.resolved is already written, the
  // driver's ask.closed for them is skipped. Bounded like ownMessageIds.
  resolvedAsks: string[];
  // The last session.state written; null before the first.
  state: SessionState | null;
  // The closing summary in flight (thread.finish): the prompt's id, the turn
  // it opened once known, and when it was asked for (the timeout).
  finish: { messageId: string; turnId: string | null; startedAt: string } | null;
  // The newest text of the current (or last) turn — the finish fallback.
  lastTurnText: string;
  // The watch failing: since when, and when the owner was last told.
  failingSince: string | null;
  warnedAt: string | null;
};

export const OWN_IDS_KEEP = 200;

export type RemoteRow = {
  threadId: string;
  userId: string;
  kind: string;
  ref: string;
  link: string | null;
  cursor: JsonValue | null;
  watch: WatchState;
  phase: RemotePhase;
  // The engine's durable position over the thread's inbound events: the
  // seq of the last one applied to the session (listInboundEvents reads
  // after it). Advanced in the same transaction as the verb's effect.
  inboundSeq: bigint;
  nextPollAt: Date;
  pollFailures: number;
  lastActivityAt: Date;
};

export type RowPatch = Partial<Pick<RemoteRow, 'cursor' | 'watch' | 'phase' | 'inboundSeq' | 'nextPollAt' | 'pollFailures' | 'lastActivityAt' | 'link'>>;

// A second live thread for one session (the partial unique index of the
// migration): the thread that has it, when it could be found.
export class RemoteRowConflict extends Error {
  readonly existingThreadId: string | null;

  constructor(kind: string, ref: string, existingThreadId: string | null) {
    super(`the session ${ref} of ${kind} already has a thread${existingThreadId ? ` (${existingThreadId})` : ''}`);
    this.name = 'RemoteRowConflict';
    this.existingThreadId = existingThreadId;
  }
}

export function initialWatch(input: Pick<WatchState, 'headless' | 'parentId' | 'notification'> & Partial<WatchState>): WatchState {
  return {
    ownMessageIds: [],
    openAsks: [],
    resolvedAsks: [],
    state: null,
    finish: null,
    lastTurnText: '',
    failingSince: null,
    warnedAt: null,
    ...input,
  };
}

function toRow(row: RemoteThreadModel): RemoteRow {
  return {
    threadId: row.threadId,
    userId: row.userId,
    kind: row.kind,
    ref: row.ref,
    link: row.link,
    cursor: (row.cursor ?? null) as JsonValue | null,
    watch: row.watch as WatchState,
    phase: row.phase as RemotePhase,
    inboundSeq: row.inboundSeq,
    nextPollAt: row.nextPollAt,
    pollFailures: row.pollFailures,
    lastActivityAt: row.lastActivityAt,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002';
}

async function appendAll(tx: Prisma.TransactionClient, events: AppendInput[]): Promise<bigint[]> {
  const seqs: bigint[] = [];

  for (const event of events) {
    const result = await appendEventIn(tx, event);

    if (result.written) {
      seqs.push(result.event.seq);
    }
  }

  return seqs;
}

export type CreateRowInput = Pick<RemoteRow, 'threadId' | 'userId' | 'kind' | 'ref' | 'link' | 'watch' | 'phase' | 'inboundSeq'> & { cursor?: JsonValue | null; lastActivityAt?: Date; nextPollAt?: Date };

// The row of a freshly opened or adopted thread with the events of its
// opening (session.started, session.state) — one transaction. A second
// live thread for the same session is RemoteRowConflict.
export async function createRow(input: CreateRowInput, events: AppendInput[]): Promise<RemoteRow> {
  let seqs: bigint[] = [];

  try {
    const row = await logTransaction(async tx => {
      const created = await tx.remoteThread.create({
        data: {
          threadId: input.threadId,
          userId: input.userId,
          kind: input.kind,
          ref: input.ref,
          link: input.link,
          watch: input.watch as unknown as Prisma.InputJsonValue,
          phase: input.phase,
          inboundSeq: input.inboundSeq,
          ...(input.cursor !== undefined && input.cursor !== null ? { cursor: input.cursor as Prisma.InputJsonValue } : {}),
          ...(input.lastActivityAt ? { lastActivityAt: input.lastActivityAt } : {}),
          ...(input.nextPollAt ? { nextPollAt: input.nextPollAt } : {}),
        },
      });

      seqs = await appendAll(tx, events);

      return created;
    });

    for (const seq of seqs) {
      notifyAppended(seq);
    }

    return toRow(row);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new RemoteRowConflict(input.kind, input.ref, (await findLiveRow(input.kind, input.ref))?.threadId ?? null);
    }

    throw error;
  }
}

export async function getRow(threadId: string): Promise<RemoteRow | null> {
  const row = await prisma.remoteThread.findUnique({ where: { threadId } });

  return row ? toRow(row) : null;
}

export const LIVE_PHASES: RemotePhase[] = ['working', 'idle', 'asking', 'paused', 'finishing'];

// The live thread of a session, if any.
export async function findLiveRow(kind: string, ref: string): Promise<RemoteRow | null> {
  const row = await prisma.remoteThread.findFirst({ where: { kind, ref, phase: { in: LIVE_PHASES } } });

  return row ? toRow(row) : null;
}

// Every live row — the boot sweep of the engine (the inbound events a dead
// process left unapplied).
export async function listLiveRows(): Promise<RemoteRow[]> {
  const rows = await prisma.remoteThread.findMany({ where: { phase: { in: LIVE_PHASES } }, orderBy: { threadId: 'asc' } });

  return rows.map(toRow);
}

// The inbound events of a thread after a seq, oldest first: the owner's
// messages authored in it (user.message — the mirror's own, source
// 'remote', among them: the engine tells them apart) and the commands
// addressed to it (thread.message of the parent, thread.decide,
// thread.finish, thread.pause). What the facade is woken for; read by the
// durable position, not from memory.
export const INBOUND_ADDRESSED_TYPES = [THREAD_MESSAGE, THREAD_DECIDE, THREAD_FINISH, THREAD_PAUSE];

export async function listInboundEvents(threadId: string, afterSeq: bigint, limit: number): Promise<Event[]> {
  const rows = await prisma.event.findMany({
    where: {
      seq: { gt: afterSeq },
      OR: [
        { threadId, type: 'user.message' },
        { targetThreadId: threadId, type: { in: INBOUND_ADDRESSED_TYPES } },
      ],
    },
    orderBy: { seq: 'asc' },
    take: limit,
  });

  return rows.map(toEvent);
}

// The rows due for a read: alive (not closed, not gone) and past their
// next_poll_at, the longest waiting first. A candidate list: the engine
// reads the row again under its lock before acting on it.
export async function listDueRows(now: Date, limit: number): Promise<RemoteRow[]> {
  const rows = await prisma.remoteThread.findMany({
    where: { phase: { in: LIVE_PHASES }, nextPollAt: { lte: now } },
    orderBy: { nextPollAt: 'asc' },
    take: limit,
  });

  return rows.map(toRow);
}

// Advance the row and write the events that go with the advance (the mirror
// of a read, the state after an inbound verb, a terminal) in one
// transaction. Returns the seqs written.
export async function advanceRow(threadId: string, patch: RowPatch, events: AppendInput[] = []): Promise<bigint[]> {
  const seqs = await logTransaction(async tx => {
    const written = await appendAll(tx, events);

    await tx.remoteThread.update({
      where: { threadId },
      data: {
        ...(patch.cursor !== undefined ? { cursor: patch.cursor === null ? Prisma.JsonNull : (patch.cursor as Prisma.InputJsonValue) } : {}),
        ...(patch.watch !== undefined ? { watch: patch.watch as unknown as Prisma.InputJsonValue } : {}),
        ...(patch.phase !== undefined ? { phase: patch.phase } : {}),
        ...(patch.inboundSeq !== undefined ? { inboundSeq: patch.inboundSeq } : {}),
        ...(patch.nextPollAt !== undefined ? { nextPollAt: patch.nextPollAt } : {}),
        ...(patch.pollFailures !== undefined ? { pollFailures: patch.pollFailures } : {}),
        ...(patch.lastActivityAt !== undefined ? { lastActivityAt: patch.lastActivityAt } : {}),
        ...(patch.link !== undefined ? { link: patch.link } : {}),
      },
    });

    return written;
  });

  for (const seq of seqs) {
    notifyAppended(seq);
  }

  return seqs;
}

export function rememberOwnMessage(watch: WatchState, messageId: string): WatchState {
  return { ...watch, ownMessageIds: [...watch.ownMessageIds, messageId].slice(-OWN_IDS_KEEP) };
}
