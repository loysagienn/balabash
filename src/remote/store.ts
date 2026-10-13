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
import type { JsonValue, NotificationLevel } from '../core/contract.ts';
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
  nextPollAt: Date;
  pollFailures: number;
  lastActivityAt: Date;
};

export type RowPatch = Partial<Pick<RemoteRow, 'cursor' | 'watch' | 'phase' | 'nextPollAt' | 'pollFailures' | 'lastActivityAt' | 'link'>>;

export class RemoteRowConflict extends Error {
  constructor(kind: string, ref: string) {
    super(`the session ${ref} of ${kind} already has a thread`);
    this.name = 'RemoteRowConflict';
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

export type CreateRowInput = Pick<RemoteRow, 'threadId' | 'userId' | 'kind' | 'ref' | 'link' | 'watch' | 'phase'> & { lastActivityAt?: Date; nextPollAt?: Date };

// The row of a freshly opened or adopted thread with the events of its
// opening (session.started, session.state) — one transaction. A second
// thread for the same session is RemoteRowConflict.
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
      throw new RemoteRowConflict(input.kind, input.ref);
    }

    throw error;
  }
}

export async function getRow(threadId: string): Promise<RemoteRow | null> {
  const row = await prisma.remoteThread.findUnique({ where: { threadId } });

  return row ? toRow(row) : null;
}

// The rows due for a read: alive (not closed, not gone) and past their
// next_poll_at, the longest waiting first.
export async function listDueRows(now: Date, limit: number): Promise<RemoteRow[]> {
  const rows = await prisma.remoteThread.findMany({
    where: { phase: { notIn: ['closed', 'gone'] }, nextPollAt: { lte: now } },
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
