// The single write point of the event log (design doc §4.3). Owns the
// envelope: one-hop validation, dead-target redirect, terminal serialization
// and the synchronous threads projection — lifecycle events and their
// projection rows are written in one transaction (§5.3).

import type { Prisma } from '../../prisma-generated/client.ts';
import { prisma } from '../db/client.ts';
import type { Event, JsonObject } from './contract.ts';
import {
  AppendError,
  TERMINAL_TYPES,
  THREAD_CANCEL,
  THREAD_CANCELLED,
  THREAD_COMPLETED,
  THREAD_PROGRESS,
  THREAD_STARTED,
  toEvent,
  validateEnvelope,
} from './envelope.ts';
import type { AppendInput } from './envelope.ts';

export type AppendResult =
  | { written: true; event: Event }
  // No-op appends (§4.3): a second terminal for an already-terminated thread,
  // or a cancel whose target is already terminal — the goal is already met.
  | { written: false; reason: 'already_terminal' | 'target_already_terminal' };

type Tx = Prisma.TransactionClient;

// Row shape used for locking reads; column aliases match the Thread model.
type ThreadRow = {
  id: string;
  userId: string;
  parentId: string | null;
  status: string;
};

async function lockThread(tx: Tx, id: string): Promise<ThreadRow | null> {
  const rows = await tx.$queryRaw<ThreadRow[]>`
    SELECT id, user_id AS "userId", parent_id AS "parentId", status
    FROM threads WHERE id = ${id} FOR UPDATE`;

  return rows[0] ?? null;
}

async function lockActiveDescendants(tx: Tx, threadId: string): Promise<ThreadRow[]> {
  return tx.$queryRaw<ThreadRow[]>`
    WITH RECURSIVE subtree AS (
      SELECT id FROM threads WHERE parent_id = ${threadId}
      UNION ALL
      SELECT t.id FROM threads t JOIN subtree s ON t.parent_id = s.id
    )
    SELECT id, user_id AS "userId", parent_id AS "parentId", status
    FROM threads
    WHERE id IN (SELECT id FROM subtree) AND status = 'active'
    ORDER BY created_seq
    FOR UPDATE`;
}

async function createEvent(tx: Tx, input: AppendInput): Promise<Event> {
  const row = await tx.event.create({
    data: {
      type: input.type,
      actor: input.actor,
      agentName: input.agentName ?? null,
      userId: input.userId,
      threadId: input.threadId ?? null,
      targetThreadId: input.targetThreadId ?? null,
      payload: input.payload as Prisma.InputJsonValue,
      schemaVersion: input.schemaVersion ?? 1,
    },
  });

  return toEvent(row);
}

export async function appendEvent(input: AppendInput): Promise<AppendResult> {
  validateEnvelope(input);

  if (input.type === THREAD_STARTED) {
    return prisma.$transaction(tx => appendThreadStarted(tx, input));
  }

  if (TERMINAL_TYPES.has(input.type)) {
    return prisma.$transaction(tx => appendTerminal(tx, input));
  }

  if (input.type === THREAD_CANCEL) {
    return prisma.$transaction(tx => appendCancelCommand(tx, input));
  }

  return prisma.$transaction(tx => appendGeneric(tx, input));
}

// ---------------------------------------------------------------------------
// thread.started: the event's threadId IS the new thread, target is the
// parent (§5.1). The projection row is created in the same transaction.

async function appendThreadStarted(tx: Tx, input: AppendInput): Promise<AppendResult> {
  const threadId = input.threadId!;
  const { userId, targetThreadId } = input;

  if (!userId) {
    throw new AppendError('user_required', 'thread.started requires userId');
  }

  const existing = await tx.thread.findUnique({ where: { id: threadId } });

  if (existing) {
    throw new AppendError('thread_exists', `Thread ${threadId} already exists`);
  }

  if (targetThreadId) {
    // Lock the parent row: serializes spawn against a concurrent cascade —
    // either the child is created before the cascade walks the subtree, or
    // the parent is already terminal and the spawn fails here.
    const parent = await lockThread(tx, targetThreadId);

    if (!parent) {
      throw new AppendError('target_not_found', `Parent thread ${targetThreadId} does not exist`);
    }

    if (parent.userId !== userId) {
      throw new AppendError('user_mismatch', `Parent thread belongs to another workspace`);
    }

    if (parent.status !== 'active') {
      throw new AppendError('parent_terminated', `Parent thread ${targetThreadId} is ${parent.status}`);
    }
  } else {
    // A thread without a parent is the workspace's main thread — eternal and
    // unique (§5.5).
    const root = await tx.thread.findFirst({ where: { userId, parentId: null } });

    if (root) {
      throw new AppendError('root_exists', `Workspace ${userId} already has a main thread (${root.id})`);
    }
  }

  const event = await createEvent(tx, input);
  const payload = input.payload as { agent: string; title?: string };

  await tx.thread.create({
    data: {
      id: threadId,
      userId,
      parentId: targetThreadId ?? null,
      agent: payload.agent,
      title: payload.title ?? null,
      status: 'active',
      createdSeq: event.seq,
    },
  });

  return { written: true, event };
}

// ---------------------------------------------------------------------------
// Terminals: exactly one per thread, serialized by the thread row lock — the
// first one wins, a repeat is a no-op (§4.3). Terminating a thread cancels
// its whole active subtree in the same transaction (§5.4).

async function appendTerminal(tx: Tx, input: AppendInput): Promise<AppendResult> {
  const threadId = input.threadId!;
  const thread = await lockThread(tx, threadId);

  if (!thread) {
    throw new AppendError('thread_not_found', `Thread ${threadId} does not exist`);
  }

  if (thread.parentId === null) {
    throw new AppendError('main_thread_terminal', 'The main thread is eternal and cannot be terminated');
  }

  if (thread.status !== 'active') {
    return { written: false, reason: 'already_terminal' };
  }

  if (input.userId !== thread.userId) {
    throw new AppendError('user_mismatch', `Thread ${threadId} belongs to another workspace`);
  }

  if (input.targetThreadId && input.targetThreadId !== thread.parentId) {
    throw new AppendError('one_hop', 'A terminal is addressed to the parent thread');
  }

  const event = await createEvent(tx, { ...input, targetThreadId: thread.parentId });

  await tx.thread.update({
    where: { id: threadId },
    data: {
      status: input.type.slice('thread.'.length), // completed | failed | cancelled
      terminalSeq: event.seq,
      ...(input.type === THREAD_COMPLETED ? completionProjectionData(input.payload) : {}),
    },
  });

  await cascadeCancel(tx, thread, threadId);

  return { written: true, event };
}

// Projection fields a thread.completed carries besides the terminal itself:
// the summary, the retrospective description, and the one-time title
// correction (the event stays the immutable fact — thread.started keeps the
// starting title forever; the row is a projection of the current state).
// Shared by the live append and the replay fold (threads.ts).
export function completionProjectionData(payload: JsonObject): {
  summary?: Prisma.InputJsonValue;
  title?: string;
  description?: string;
} {
  const title = typeof payload.title === 'string' && payload.title.trim() ? payload.title.trim() : undefined;
  const description = typeof payload.description === 'string' ? payload.description : undefined;

  return {
    ...(payload.summary !== undefined ? { summary: payload.summary as Prisma.InputJsonValue } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(description !== undefined ? { description } : {}),
  };
}

// A thread does not outlive its parent: mark every active descendant
// cancelled, one explicit thread.cancelled event each, so the log replays
// deterministically and the projection stays derivable.
async function cascadeCancel(tx: Tx, root: ThreadRow, cascadeFromThreadId: string): Promise<void> {
  const descendants = await lockActiveDescendants(tx, cascadeFromThreadId);

  for (const descendant of descendants) {
    const event = await createEvent(tx, {
      type: THREAD_CANCELLED,
      actor: 'system',
      userId: root.userId,
      threadId: descendant.id,
      targetThreadId: descendant.parentId,
      payload: { reason: 'parent_terminated', cascadeFromThreadId },
    });

    await tx.thread.update({
      where: { id: descendant.id },
      data: { status: 'cancelled', terminalSeq: event.seq },
    });
  }
}

// ---------------------------------------------------------------------------
// thread.cancel: a command from parent to direct child. A cancel for an
// already-terminated child is a no-op — its goal is already met, and the
// dead-target redirect would only spam the main thread.

async function appendCancelCommand(tx: Tx, input: AppendInput): Promise<AppendResult> {
  const { threadId, targetThreadId } = input;

  if (!targetThreadId) {
    throw new AppendError('target_required', 'thread.cancel requires targetThreadId');
  }

  const target = await lockThread(tx, targetThreadId);

  if (!target) {
    throw new AppendError('target_not_found', `Thread ${targetThreadId} does not exist`);
  }

  if (target.parentId !== threadId) {
    throw new AppendError('one_hop', 'thread.cancel may only address a direct child');
  }

  if (target.userId !== input.userId) {
    throw new AppendError('user_mismatch', `Thread ${targetThreadId} belongs to another workspace`);
  }

  if (target.status !== 'active') {
    return { written: false, reason: 'target_already_terminal' };
  }

  const event = await createEvent(tx, input);

  return { written: true, event };
}

// ---------------------------------------------------------------------------
// Everything else: validate the author thread, then the addressee — one hop
// up or down (§4.3), with the dead-target redirect to the main thread.

async function appendGeneric(tx: Tx, input: AppendInput): Promise<AppendResult> {
  let resolved: AppendInput = input;
  const { threadId, userId } = input;

  let author: ThreadRow | null = null;

  if (threadId) {
    // No lock: a terminated author is legal (§4.3 — the log journals facts,
    // soft abort may append its tail), so there is nothing to serialize.
    const thread = await tx.thread.findUnique({
      where: { id: threadId },
      select: { id: true, userId: true, parentId: true, status: true },
    });

    if (!thread) {
      throw new AppendError('thread_not_found', `Thread ${threadId} does not exist`);
    }

    if (thread.userId !== userId) {
      throw new AppendError('user_mismatch', `Thread ${threadId} belongs to another workspace`);
    }

    author = thread;
  }

  if (input.targetThreadId) {
    resolved = await resolveTarget(tx, input, author);
  } else if (input.type === THREAD_PROGRESS) {
    // thread.progress is addressed to the parent; derive it. The main thread
    // has no parent and nothing to report progress to.
    if (!author || author.parentId === null) {
      throw new AppendError('target_required', 'thread.progress requires a parent thread');
    }

    resolved = await resolveTarget(tx, { ...input, targetThreadId: author.parentId }, author);
  }

  const event = await createEvent(tx, resolved);

  return { written: true, event };
}

async function resolveTarget(tx: Tx, input: AppendInput, author: ThreadRow | null): Promise<AppendInput> {
  const targetThreadId = input.targetThreadId!;
  // Lock: serializes against a concurrent terminal — the event either lands
  // before the terminal in the log, or sees the thread terminated and is
  // redirected.
  const target = await lockThread(tx, targetThreadId);

  if (!target) {
    throw new AppendError('target_not_found', `Thread ${targetThreadId} does not exist`);
  }

  if (input.userId !== target.userId) {
    throw new AppendError('user_mismatch', `Thread ${targetThreadId} belongs to another workspace`);
  }

  if (target.status !== 'active') {
    // Dead addressee (§4.3): redirect to the workspace's main thread — the
    // user's system journal — so the fact is not lost (e.g. an OAuth callback
    // arriving after the auth thread was cascade-cancelled). The single
    // exception to the one-hop rule.
    const main = await tx.thread.findFirst({ where: { userId: target.userId, parentId: null } });

    if (!main) {
      throw new AppendError('no_main_thread', `Workspace ${target.userId} has no main thread to redirect to`);
    }

    return {
      ...input,
      targetThreadId: main.id,
      payload: { ...input.payload, redirectedFromThreadId: targetThreadId } as JsonObject,
    };
  }

  // One hop: the addressee is the author's parent or direct child. Events
  // authored outside threads (threadId null, actor 'system' — web callbacks,
  // detectors) may address any thread of the workspace: there is no hierarchy
  // position to measure the hop from.
  if (author && target.parentId !== author.id && author.parentId !== target.id) {
    throw new AppendError('one_hop', `Thread ${targetThreadId} is neither parent nor direct child of ${author.id}`);
  }

  return input;
}
