// The one SQLite policy of the platform for workspace.sqlite — the database
// is SHARED with the user's own writers (run_script children, scheduled
// jobs, project ETL) that may hold a write transaction for tens of seconds.
// Every platform-side connection follows the same rule, written down here
// exactly once:
//
//   - A platform operation waits for a foreign lock up to LOCK_WAIT_MS
//     (~1 minute) before failing with "database is locked". A foreign
//     transaction of 25–40 s (the observed loaders) is inside the window; a
//     writer stuck for minutes is a bug on its side and is reported, not
//     waited for forever.
//   - Child processes (data_query, app endpoints — src/workspace/child.ts)
//     wait synchronously through SQLite's busy handler: the child is its own
//     process, blocking it costs nothing. Their kill timeout stays above the
//     busy timeout so the wait ends in a clear SQL error, never in a kill.
//   - In-process handles (the _files metadata, tools/workspace_files.ts and
//     the indexer) run on the app's event loop, where DatabaseSync is
//     synchronous: they wait in short busy_timeout slices (BUSY_SLICE_MS)
//     with asynchronous sleeps in between, so the app stays responsive for
//     Telegram, the web and every other thread while a foreign writer holds
//     the lock. Each attempt is a fresh connection; a failed attempt leaves
//     nothing behind (closing rolls back).
//   - Multi-statement writes go through BEGIN IMMEDIATE: the write lock is
//     taken up front (where the busy handler applies) instead of mid-
//     transaction, where SQLite refuses to wait (SQLITE_BUSY without retry).
//
// The database runs in WAL (ensureFilesDb sets it), so readers never wait
// for a writer; the waiting is for the one writer slot only.

import { DatabaseSync } from 'node:sqlite';

/** Total wait for a busy workspace.sqlite, any platform surface. */
export const LOCK_WAIT_MS = 55_000;

/** Longest synchronous busy wait of one attempt on the app's event loop. */
export const BUSY_SLICE_MS = 100;

// Margin between a child's busy timeout and its kill timeout: the statement
// itself needs time after the lock is granted, and a lock that outlasts the
// window must surface as "database is locked", not as a kill.
const CHILD_MARGIN_MS = 5_000;
const CHILD_MIN_BUSY_MS = 1_000;

// Pause between in-process attempts: short and jittered, so several waiting
// operations do not retry in lockstep.
const RETRY_MIN_MS = 50;
const RETRY_MAX_MS = 250;

/**
 * The busy timeout of an SQL child given its kill timeout: as long as the
 * policy allows, but always clear of the kill.
 */
export function childBusyTimeoutMs(childTimeoutMs: number): number {
  return Math.max(CHILD_MIN_BUSY_MS, Math.min(LOCK_WAIT_MS, childTimeoutMs - CHILD_MARGIN_MS));
}

/** True for SQLite's busy/locked family (SQLITE_BUSY, SQLITE_BUSY_*, SQLITE_LOCKED). */
export function isBusyError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const code = (error as Error & { errcode?: number }).errcode;

  // Primary result codes live in the low byte: 5 = SQLITE_BUSY, 6 = SQLITE_LOCKED.
  if (typeof code === 'number') {
    const primary = code & 0xff;
    return primary === 5 || primary === 6;
  }

  return /database is locked|database table is locked/i.test(error.message);
}

export class WorkspaceDbBusyError extends Error {
  override name = 'WorkspaceDbBusyError';

  constructor(dbPath: string, waitedMs: number, cause: unknown) {
    super(
      `workspace.sqlite is locked by another writer (waited ${Math.round(waitedMs / 1000)}s): ${dbPath}`,
      { cause },
    );
  }
}

export type WithDbOptions = {
  /** Override of LOCK_WAIT_MS (tests, or callers that must not wait long). */
  lockWaitMs?: number;
};

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Runs fn on a short-lived in-process connection with the platform's lock
 * policy: busy waits in BUSY_SLICE_MS synchronous slices, retried with
 * asynchronous pauses until LOCK_WAIT_MS has passed. fn must be retry-safe —
 * every attempt starts on a fresh connection and a busy failure never
 * commits anything (a single autocommit statement, or a transaction that
 * the close rolls back). Not for bulk work: the synchronous part still
 * runs on the event loop.
 */
export async function withWorkspaceDb<T>(
  dbPath: string,
  fn: (db: DatabaseSync) => T,
  options: WithDbOptions = {},
): Promise<T> {
  const lockWaitMs = options.lockWaitMs ?? LOCK_WAIT_MS;
  const startedAt = Date.now();

  for (;;) {
    try {
      return openAndRun(dbPath, fn);
    } catch (error) {
      if (!isBusyError(error)) {
        throw error;
      }

      const waitedMs = Date.now() - startedAt;

      if (waitedMs >= lockWaitMs) {
        throw new WorkspaceDbBusyError(dbPath, waitedMs, error);
      }

      const pause = RETRY_MIN_MS + Math.random() * (RETRY_MAX_MS - RETRY_MIN_MS);
      await sleep(Math.min(pause, Math.max(0, lockWaitMs - waitedMs)));
    }
  }
}

function openAndRun<T>(dbPath: string, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(dbPath, { timeout: BUSY_SLICE_MS });

  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/**
 * Runs fn inside BEGIN IMMEDIATE … COMMIT on an open handle: the write lock
 * is acquired first (busy-waited), then the statements run on it; any throw
 * rolls back and propagates. For one-statement writes autocommit is already
 * this — use it for anything with two or more statements.
 */
export function inWriteTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');

  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // The transaction is already gone (e.g. the connection errored); the
      // original error is the one to report.
    }

    throw error;
  }
}
