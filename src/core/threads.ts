// The threads layer outward is append + questions (§5.3): status changes only
// via lifecycle events through appendEvent, the table is private memoization.
// Reads here are for consumers where staleness is acceptable (UI, lists,
// pull tools); every read-then-write lives in append.ts.

import { randomUUID } from 'node:crypto';
import { Prisma } from '../../prisma-generated/client.ts';
import { prisma } from '../db/client.ts';
import type { DbClient } from '../db/client.ts';
import type { JsonObject, JsonValue, Thread, ThreadCounts, ThreadStatus, ThreadSummary } from './contract.ts';
import type { ThreadModel as ThreadRow } from '../../prisma-generated/models.ts';
import { appendEvent, completionProjectionData } from './append.ts';
import type { AppendResult } from './append.ts';
import { AppendError, TERMINAL_TYPES, THREAD_CANCELLED, THREAD_STARTED, toEvent } from './envelope.ts';
import { config } from '../config/index.ts';
import { threadStartFields } from '../projections/thread.ts';
import { threadsWhere } from './thread-query.ts';
import type { ThreadFilters } from './thread-query.ts';

export const COORDINATOR_AGENT = 'coordinator';

// A threads row as the reads below select it: the projection's columns
// plus `headless`, read from the thread's own thread.started.
type ThreadReadRow = ThreadRow & { headless: boolean };

function toThread(row: ThreadReadRow): Thread {
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
    headless: row.headless,
    createdSeq: row.createdSeq,
    terminalSeq: row.terminalSeq,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// Every read of threads is raw SQL over this shape: the columns of the
// projection aliased to the model's field names, and the spawn-time policy
// `headless` joined in from the thread.started the row was created by
// (`created_seq` is its seq, the primary key of events — one lookup per
// row). The row does not store the policy — the event is its only source;
// `= 'true'::jsonb` reads a boolean and nothing else as headless (a missing
// or odd value is not), with no cast that could fail on an odd payload.
const THREAD_COLUMNS = Prisma.sql`threads.id, threads.user_id AS "userId", threads.parent_id AS "parentId", threads.agent, threads.title,
       threads.description, threads.status, threads.summary, threads.project_id AS "projectId",
       COALESCE(started.payload -> 'headless' = 'true'::jsonb, false) AS headless,
       threads.created_seq AS "createdSeq", threads.terminal_seq AS "terminalSeq",
       threads.created_at AS "createdAt", threads.updated_at AS "updatedAt"`;
const THREADS_FROM = Prisma.sql`threads LEFT JOIN events started ON started.seq = threads.created_seq`;

async function readThreads(db: DbClient, where: Prisma.Sql, tail: Prisma.Sql = Prisma.empty): Promise<Thread[]> {
  const rows = await db.$queryRaw<ThreadReadRow[]>`
    SELECT ${THREAD_COLUMNS}
    FROM ${THREADS_FROM}
    WHERE ${where}
    ${tail}`;

  return rows.map(toThread);
}

export async function getThread(id: string): Promise<Thread | null> {
  const [thread] = await readThreads(prisma, Prisma.sql`threads.id = ${id}`);

  return thread ?? null;
}

type ListThreadsOptions = ThreadFilters & {
  limit?: number;
  // 'asc' (default) keeps the historical shape: the newest matching window
  // returned in creation order. 'desc' returns newest first — the web
  // window's feed order.
  order?: 'asc' | 'desc';
};

export async function listThreads(userId: string, { limit = 100, order = 'asc', ...filters }: ListThreadsOptions = {}): Promise<Thread[]> {
  // The limit keeps the newest matching threads (the useful end of a growing
  // workspace) regardless of the output order. Raw SQL: the filters are the
  // fragments of thread-query.ts (the search reaches into the summary).
  const threads = await readThreads(prisma, threadsWhere(userId, filters), Prisma.sql`ORDER BY threads.created_seq DESC LIMIT ${limit}`);

  if (order === 'asc') {
    threads.reverse();
  }

  return threads;
}

// The thread of the workspace that ended last — the one with the greatest
// terminal seq; null while none has. The snapshot carries it so the
// console's "the last thread finished …" is the log's answer, not the
// window's.
export async function getLatestTerminalThread(userId: string): Promise<Thread | null> {
  const [thread] = await readThreads(
    prisma,
    Prisma.sql`threads.user_id = ${userId} AND threads.terminal_seq IS NOT NULL`,
    Prisma.sql`ORDER BY threads.terminal_seq DESC LIMIT 1`,
  );

  return thread ?? null;
}

export type ThreadCountFilters = Omit<ThreadFilters, 'status' | 'beforeCreatedSeq'>;

// How many threads of the workspace fall under each status with the same
// filters (status and cursor aside) — the segments of the threads list.
export async function countThreads(userId: string, filters: ThreadCountFilters, db: DbClient = prisma): Promise<ThreadCounts> {
  const rows = await db.$queryRaw<{ status: string; n: number }[]>`
    SELECT status, COUNT(*)::int AS n
    FROM threads
    WHERE ${threadsWhere(userId, filters)}
    GROUP BY status`;
  const counts: ThreadCounts = { active: 0, completed: 0, failed: 0, cancelled: 0 };

  for (const row of rows) {
    if (row.status in counts) {
      counts[row.status as ThreadStatus] = row.n;
    }
  }

  return counts;
}

// The counts stamped with the log position they are read at: one
// REPEATABLE READ transaction reads the head of the log and the counts from
// the same snapshot, so the counts hold exactly the terminals the stamp's
// log holds (the lifecycle events and their projection rows commit
// together), and no terminal above the stamp. The console folds the tail's
// terminals above the stamp onto the counts and leaves those below alone —
// whichever of the page and the tail lands first. The stamp is the head of
// what was committed, not a prefix of the sequence: seq is allocated at
// insert and transactions commit in any order, so a terminal with a lower
// seq that commits after the snapshot is in neither the counts nor a read
// strictly after the stamp (the same holds for every cursor over the log).
export async function countThreadsAt(userId: string, filters: ThreadCountFilters): Promise<{ counts: ThreadCounts; asOfSeq: bigint }> {
  return prisma.$transaction(
    async tx => {
      const { _max } = await tx.event.aggregate({ _max: { seq: true } });
      const counts = await countThreads(userId, filters, tx);

      return { counts, asOfSeq: _max.seq ?? 0n };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}

// Every active non-main thread across all workspaces — the restart module's
// safe-window check (a pending restart waits until this list is empty).
export async function listActiveChildThreads(): Promise<Thread[]> {
  return readThreads(prisma, Prisma.sql`threads.status = 'active' AND threads.parent_id IS NOT NULL`, Prisma.sql`ORDER BY threads.created_seq`);
}

// The workspace's main thread: the only thread without a parent (§5.5).
export async function getMainThread(userId: string, db: DbClient = prisma): Promise<Thread | null> {
  const [thread] = await readThreads(db, Prisma.sql`threads.user_id = ${userId} AND threads.parent_id IS NULL`, Prisma.sql`LIMIT 1`);

  return thread ?? null;
}

// Active threads of the subtree rooted at threadId, root included, in
// creation order — the runtime's view for cascade aborts and status tails.
export async function activeSubtree(threadId: string): Promise<Thread[]> {
  const subtree = Prisma.sql`
    WITH RECURSIVE subtree AS (
      SELECT id FROM threads WHERE id = ${threadId}
      UNION ALL
      SELECT t.id FROM threads t JOIN subtree s ON t.parent_id = s.id
    )
    SELECT id FROM subtree`;

  return readThreads(prisma, Prisma.sql`threads.id IN (${subtree}) AND threads.status = 'active'`, Prisma.sql`ORDER BY threads.created_seq`);
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
