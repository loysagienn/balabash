// The threads layer outward is append + questions (§5.3): status changes only
// via lifecycle events through appendEvent, the table is private memoization.
// Reads here are for consumers where staleness is acceptable (UI, lists,
// pull tools); every read-then-write lives in append.ts.

import { randomUUID } from 'node:crypto';
import { prisma } from '../db/client.ts';
import type { DbClient } from '../db/client.ts';
import type { JsonObject, JsonValue, Thread, ThreadStatus, ThreadSummary } from './contract.ts';
import type { ThreadModel as ThreadRow } from '../../prisma-generated/models.ts';
import { appendEvent, completionProjectionData } from './append.ts';
import type { AppendResult } from './append.ts';
import { AppendError, TERMINAL_TYPES, THREAD_CANCELLED, THREAD_STARTED, toEvent } from './envelope.ts';
import { config } from '../config/index.ts';
import { threadStartFields } from '../projections/thread.ts';

export const COORDINATOR_AGENT = 'coordinator';

function toThread(row: ThreadRow): Thread {
  return {
    id: row.id,
    userId: row.userId,
    parentId: row.parentId,
    agent: row.agent,
    title: row.title,
    description: row.description,
    status: row.status as ThreadStatus,
    summary: row.summary as ThreadSummary | null,
    projectId: row.projectId,
    createdSeq: row.createdSeq,
    terminalSeq: row.terminalSeq,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function getThread(id: string): Promise<Thread | null> {
  const row = await prisma.thread.findUnique({ where: { id } });

  return row ? toThread(row) : null;
}

type ListThreadsOptions = {
  status?: ThreadStatus;
  parentId?: string | null;
  projectId?: string;
  createdAtGte?: Date;
  createdAtLte?: Date;
  // Cursor for newest-first pagination: only threads with
  // createdSeq < beforeCreatedSeq. createdSeq is unique (the global seq of
  // thread.started), so equal createdAt timestamps page deterministically.
  beforeCreatedSeq?: bigint;
  limit?: number;
  // 'asc' (default) keeps the historical shape: the newest matching window
  // returned in creation order. 'desc' returns newest first — the web
  // window's feed order.
  order?: 'asc' | 'desc';
};

export async function listThreads(
  userId: string,
  { status, parentId, projectId, createdAtGte, createdAtLte, beforeCreatedSeq, limit = 100, order = 'asc' }: ListThreadsOptions = {},
): Promise<Thread[]> {
  // The limit keeps the newest matching threads (the useful end of a growing
  // workspace) regardless of the output order.
  const rows = await prisma.thread.findMany({
    where: {
      userId,
      ...(status !== undefined ? { status } : {}),
      ...(parentId !== undefined ? { parentId } : {}),
      ...(projectId !== undefined ? { projectId } : {}),
      ...(beforeCreatedSeq !== undefined ? { createdSeq: { lt: beforeCreatedSeq } } : {}),
      ...(createdAtGte !== undefined || createdAtLte !== undefined
        ? {
            createdAt: {
              ...(createdAtGte !== undefined ? { gte: createdAtGte } : {}),
              ...(createdAtLte !== undefined ? { lte: createdAtLte } : {}),
            },
          }
        : {}),
    },
    orderBy: { createdSeq: 'desc' },
    take: limit,
  });

  if (order === 'asc') {
    rows.reverse();
  }

  return rows.map(toThread);
}

// Every active non-main thread across all workspaces — the restart module's
// safe-window check (a pending restart waits until this list is empty).
export async function listActiveChildThreads(): Promise<Thread[]> {
  const rows = await prisma.thread.findMany({
    where: { status: 'active', parentId: { not: null } },
    orderBy: { createdSeq: 'asc' },
  });

  return rows.map(toThread);
}

// The workspace's main thread: the only thread without a parent (§5.5).
export async function getMainThread(userId: string, db: DbClient = prisma): Promise<Thread | null> {
  const row = await db.thread.findFirst({ where: { userId, parentId: null } });

  return row ? toThread(row) : null;
}

// Active threads of the subtree rooted at threadId, root included, in
// creation order — the runtime's view for cascade aborts and status tails.
export async function activeSubtree(threadId: string): Promise<Thread[]> {
  const rows = await prisma.$queryRaw<ThreadRow[]>`
    WITH RECURSIVE subtree AS (
      SELECT id FROM threads WHERE id = ${threadId}
      UNION ALL
      SELECT t.id FROM threads t JOIN subtree s ON t.parent_id = s.id
    )
    SELECT id, user_id AS "userId", parent_id AS "parentId", agent, title, description, status, summary,
           project_id AS "projectId",
           created_seq AS "createdSeq", terminal_seq AS "terminalSeq",
           created_at AS "createdAt", updated_at AS "updatedAt"
    FROM threads
    WHERE id IN (SELECT id FROM subtree) AND status = 'active'
    ORDER BY created_seq`;

  return rows.map(toThread);
}

// ---------------------------------------------------------------------------
// Workspace activation (§5.5): the main thread is created once, eternally
// active, coordinator-owned. Idempotent.

export async function ensureMainThread(userId: string): Promise<Thread> {
  const existing = await getMainThread(userId);

  if (existing) {
    return existing;
  }

  const threadId = randomUUID();

  try {
    await appendEvent({
      type: THREAD_STARTED,
      actor: 'system',
      userId,
      threadId,
      payload: { agent: COORDINATOR_AGENT },
    });
  } catch (error) {
    // Lost a concurrent activation race — the winner's thread is ours too.
    if (error instanceof AppendError && error.code === 'root_exists') {
      const winner = await getMainThread(userId);

      if (winner) {
        return winner;
      }
    }

    throw error;
  }

  return (await getThread(threadId))!;
}

// The operator's workspace, channel-neutrally: the one workspace of this
// installation that a singleton channel (CCR, whose credentials are one
// account) or the channel-less web login (the console code of /login) serves.
// Telegram keeps its own binding — group ↔ user in telegram_groups, created
// by /start — and may hold several workspaces; this resolves exactly one:
// a single user is it, no user at all (a fresh install without Telegram) is
// created here together with its main thread — the channel-neutral analogue
// of /start — and several users need OPERATOR_USER_ID to disambiguate (a
// loud error instead of a silent "oldest wins").
export async function ensureOperatorWorkspace(): Promise<Thread> {
  const users = await prisma.user.findMany({ select: { id: true }, orderBy: { createdAt: 'asc' } });
  const configured = config.operatorUserId;

  let userId: string;

  if (configured) {
    if (!users.some(user => user.id === configured)) {
      throw new Error(`OPERATOR_USER_ID ${configured} does not exist in the users table`);
    }

    userId = configured;
  } else if (users.length === 1) {
    userId = users[0].id;
  } else if (users.length === 0) {
    userId = (await prisma.user.create({ data: {} })).id;
    console.log(`[threads] operator workspace created: user ${userId}`);
  } else {
    throw new Error(
      `several users in the database — set OPERATOR_USER_ID to the operator's workspace: ${users.map(user => user.id).join(', ')}`,
    );
  }

  return ensureMainThread(userId);
}

// The spawn-time policy of a thread lives in its thread.started payload —
// the projection does not store it. Headless = no user surface by
// declaration: the dialogue is with the parent only (no topic, no CCR
// session, no web chat input).
export async function isHeadlessThread(threadId: string): Promise<boolean> {
  const row = await prisma.event.findFirst({ where: { threadId, type: THREAD_STARTED }, select: { payload: true } });
  const payload = row?.payload;

  return typeof payload === 'object' && payload !== null && !Array.isArray(payload) && (payload as JsonObject).headless === true;
}

// Spawn helper: generates the thread id and writes thread.started addressed
// to the parent. The runtime builds on this; input/title come from the
// spawner.
type StartThreadInput = {
  userId: string;
  parentThreadId: string;
  agent: string;
  title?: string;
  // The spawn prompt — every agent's input is one text prompt.
  input?: string;
  // Spawn-time policy riding in the payload (§7.4, §11.3): the notification
  // level of the thread and the narrowed tool bundle. The projection does not
  // store them — consumers read them from the thread.started event.
  notification?: string;
  tools?: string[];
  // The spawned agent's thread icon (§11.2): adapters know only core, so the
  // surface hint travels in the event, not in the catalog.
  icon?: string;
  // Headless thread (§11.2): no user surface — adapters create none for it
  // (e.g. no Telegram topic). Like
  // icon, the hint comes from the spawned agent's declaration and travels in
  // the event.
  headless?: boolean;
  // The project the thread works for (resolved by the spawner): the id is
  // what the projection stores and the console filters on, the slug is the
  // human-readable address at spawn time.
  project?: { id: string; slug: string };
  actor: 'system' | 'agent';
  agentName?: string; // the SPAWNING agent, not the spawned one
};

export async function startThread(options: StartThreadInput): Promise<Thread> {
  const threadId = randomUUID();
  const payload: JsonObject = { agent: options.agent };

  if (options.title !== undefined) {
    payload.title = options.title;
  }

  if (options.input !== undefined) {
    payload.input = options.input;
  }

  if (options.notification !== undefined) {
    payload.notification = options.notification;
  }

  if (options.tools !== undefined) {
    payload.tools = options.tools;
  }

  if (options.icon !== undefined) {
    payload.icon = options.icon;
  }

  if (options.headless !== undefined) {
    payload.headless = options.headless;
  }

  if (options.project !== undefined) {
    payload.projectId = options.project.id;
    payload.projectSlug = options.project.slug;
  }

  await appendEvent({
    type: THREAD_STARTED,
    actor: options.actor,
    agentName: options.agentName ?? null,
    userId: options.userId,
    threadId,
    targetThreadId: options.parentThreadId,
    payload,
  });

  return (await getThread(threadId))!;
}

// ---------------------------------------------------------------------------
// Tombstone (§5.5): on process start every active non-main thread is
// cancelled — runs live only in memory and did not survive the restart.
// Cancelling a thread cascades over its subtree inside appendEvent, so
// descendants reached later in the loop are already terminal no-ops.

export async function tombstoneActiveThreads(reason: string): Promise<number> {
  const rows = await prisma.thread.findMany({
    where: { status: 'active', parentId: { not: null } },
    orderBy: { createdSeq: 'asc' },
    select: { id: true, userId: true },
  });

  let cancelled = 0;

  for (const row of rows) {
    const result: AppendResult = await appendEvent({
      type: THREAD_CANCELLED,
      actor: 'system',
      userId: row.userId,
      threadId: row.id,
      payload: { reason },
    });

    if (result.written) {
      cancelled += 1;
    }
  }

  return cancelled;
}

// ---------------------------------------------------------------------------
// Projection rebuild: truncate + replay of lifecycle events (§5.3). The log
// is complete — cascades write explicit thread.cancelled events — so replay
// is a plain fold. Run offline (stopped process).

// db: the root client or a transaction — the import script rebuilds inside
// the transaction that loads the log, so a failure leaves nothing behind.
export async function rebuildThreadsProjection(db: DbClient = prisma): Promise<{ threads: number; terminals: number }> {
  await db.$executeRaw`TRUNCATE TABLE threads`;

  const stats = { threads: 0, terminals: 0 };
  const batchSize = 500;
  let cursor = 0n;

  for (;;) {
    const events = await db.event.findMany({
      where: {
        seq: { gt: cursor },
        type: { in: [THREAD_STARTED, ...TERMINAL_TYPES] },
      },
      orderBy: { seq: 'asc' },
      take: batchSize,
    });

    if (events.length === 0) {
      return stats;
    }

    for (const row of events) {
      const event = toEvent(row);

      if (event.type === THREAD_STARTED) {
        const { agent, title, projectId } = threadStartFields(event.payload);

        // Timestamps come from the log, not the clock: a rebuilt row must
        // date like the live one did (list_threads filters and pages on
        // createdAt).
        await db.thread.create({
          data: {
            id: event.threadId!,
            userId: event.userId!,
            parentId: event.targetThreadId,
            agent,
            title,
            projectId,
            status: 'active',
            createdSeq: event.seq,
            createdAt: event.createdAt,
            updatedAt: event.createdAt,
          },
        });
        stats.threads += 1;
      } else {
        const thread = await db.thread.findUnique({ where: { id: event.threadId! } });

        // First terminal wins; append never writes a second one, but replay
        // stays defensive.
        if (thread && thread.status === 'active') {
          await db.thread.update({
            where: { id: thread.id },
            data: {
              status: event.type.slice('thread.'.length),
              terminalSeq: event.seq,
              updatedAt: event.createdAt,
              ...(event.type === 'thread.completed' ? completionProjectionData(event.payload) : {}),
            },
          });
          stats.terminals += 1;
        }
      }

      cursor = event.seq;
    }
  }
}
