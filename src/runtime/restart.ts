// The restart module: turns a system.restart.requested event into a clean
// process exit inside a safe window, so the supervisor (supervisor.js) boots
// the freshly built bundle. Restart is the only reload — hot-reload is gone
// by design.
//
// The safe window is structural first, heuristic second:
// - no active non-main thread in any workspace (the projection),
// - no coordinator turn in flight (injected — the in-memory truth; a pure
//   "quiet log" heuristic would kill a turn mid-inference and lose the
//   reply, because the lazy rise cannot replay it),
// - 20s of log quiet as a buffer against updates already inside an adapter
//   but not yet appended.
//
// The pending state is derivable: on boot the fresh process completes every
// request the log holds after the last completion (a crash restart satisfies
// a request too), addressing the requester thread — the dead-target redirect
// delivers it to the main thread when the requester already finished.

import { readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { appendEvent } from '../core/append.ts';
import { startConsumer } from '../core/consumers.ts';
import type { Consumer } from '../core/consumers.ts';
import {
  SYSTEM_EXCEPTION,
  SYSTEM_RESTART_COMPLETED,
  SYSTEM_RESTART_REQUESTED,
  THREAD_NOTIFICATION,
} from '../core/envelope.ts';
import { getEventsAfter, getLastEventSeq, getLogQuietSeconds } from '../core/events.ts';
import { getMainThread, listActiveChildThreads, tombstoneActiveThreads } from '../core/threads.ts';

// Kept in sync with supervisor.js by hand — the supervisor is dependency-free
// and never imports the bundle.
export const RESTART_EXIT_CODE = 42;

const ROLLBACK_MARKER_PATH = path.resolve('data', 'supervisor', 'rollback.json');

const POLL_INTERVAL_MS = 3_000;
const QUIET_WINDOW_SECONDS = 20;
const PENDING_NOTIFY_AFTER_MS = 5 * 60_000;

type PendingRestart = {
  seq: bigint;
  userId: string | null;
  threadId: string | null;
  reason: string;
  force: boolean;
  requestedAt: Date;
  forceApplied: boolean;
  notified: boolean;
};

let pending: PendingRestart | null = null;

// The coordinator's status tail shows this (volatile, outside the cache head).
export function getPendingRestart(): { reason: string; requestedAt: Date } | null {
  return pending ? { reason: pending.reason, requestedAt: pending.requestedAt } : null;
}

async function readRollbackMarker(): Promise<{ at?: string; reason?: string } | null> {
  let raw: string;

  try {
    raw = await readFile(ROLLBACK_MARKER_PATH, 'utf8');
  } catch {
    return null;
  }

  await unlink(ROLLBACK_MARKER_PATH).catch(() => {});

  try {
    return JSON.parse(raw) as { at?: string; reason?: string };
  } catch {
    return {};
  }
}

// Boot sweep: every process start satisfies every request recorded before it
// (a planned exit and a crash relaunch alike boot whatever dist holds), so
// the fresh process reports completion for each request after the last
// completed. A supervisor rollback rides along in the payload — the
// coordinator can tell the user honestly that the old bundle is running.
export async function completePendingRestarts({
  migrationsError = null,
}: { migrationsError?: string | null } = {}): Promise<void> {
  const rollback = await readRollbackMarker();
  const lastCompletedSeq = (await getLastEventSeq(SYSTEM_RESTART_COMPLETED)) ?? 0n;
  const requests = await getEventsAfter(lastCompletedSeq, { types: [SYSTEM_RESTART_REQUESTED], limit: 50 });

  for (const request of requests) {
    if (!request.userId) {
      continue;
    }

    const target = request.threadId ?? (await getMainThread(request.userId))?.id ?? null;

    if (!target) {
      continue;
    }

    await appendEvent({
      type: SYSTEM_RESTART_COMPLETED,
      actor: 'system',
      userId: request.userId,
      threadId: null,
      targetThreadId: target,
      payload: {
        requestSeq: Number(request.seq),
        reason: typeof request.payload.reason === 'string' ? request.payload.reason : 'restart',
        ...(rollback ? { rolledBack: true, rollbackReason: rollback.reason ?? 'crash-loop' } : {}),
        ...(migrationsError ? { migrationsFailed: migrationsError } : {}),
      },
    });
  }

  if (requests.length) {
    console.log(`[restart] completed ${requests.length} pending restart request(s)`);
  }

  // A rollback without a pending request still deserves a trace: the crash
  // loop that caused it may have had nothing to do with a restart request.
  if (rollback && !requests.length) {
    await appendEvent({
      type: SYSTEM_EXCEPTION,
      actor: 'system',
      userId: null,
      payload: {
        scope: 'supervisor-rollback',
        error: `Supervisor rolled back to the last good bundle (${rollback.reason ?? 'crash-loop'} at ${rollback.at ?? 'unknown time'})`,
      },
    });
  }

  // A migration failure is journaled unconditionally — the process is booted
  // on the old schema and every consumer of the log deserves to know.
  if (migrationsError) {
    await appendEvent({
      type: SYSTEM_EXCEPTION,
      actor: 'system',
      userId: null,
      payload: { scope: 'migrate-deploy', error: migrationsError },
    });
  }
}

type RestartModuleHooks = {
  // In-memory truth about coordinator turns in flight — injected by the
  // composition root (the runtime does not know the coordinator, §3).
  isBusy(): boolean;
  // Graceful shutdown ending in process.exit(RESTART_EXIT_CODE).
  onRestartWindow(): Promise<void>;
};

export function startRestartModule({ isBusy, onRestartWindow }: RestartModuleHooks): Consumer {
  let exiting = false;

  const notifyLongPending = async (current: PendingRestart, blockedBy: string[]): Promise<void> => {
    if (current.notified || !current.userId || Date.now() - current.requestedAt.getTime() < PENDING_NOTIFY_AFTER_MS) {
      return;
    }

    current.notified = true;

    const main = await getMainThread(current.userId);

    if (!main) {
      return;
    }

    await appendEvent({
      type: THREAD_NOTIFICATION,
      actor: 'system',
      userId: current.userId,
      threadId: main.id,
      payload: {
        level: 'normal',
        text: `Restart is still pending (${current.reason}) — waiting for: ${blockedBy.join(', ')}.`,
      },
    });
  };

  const poll = async (): Promise<void> => {
    const current = pending;

    if (!current || exiting) {
      return;
    }

    // Force: open the window by cancelling every active non-main thread —
    // the ordinary cascade machinery, one explicit terminal each.
    if (current.force && !current.forceApplied) {
      current.forceApplied = true;

      const cancelled = await tombstoneActiveThreads('restart_requested');

      console.log(`[restart] force: cancelled ${cancelled} active thread(s)`);

      return;
    }

    const activeChildren = await listActiveChildThreads();
    const blockedBy: string[] = [];

    if (activeChildren.length) {
      blockedBy.push(
        `${activeChildren.length} active thread(s): ${activeChildren
          .slice(0, 5)
          .map(thread => thread.title ?? thread.agent)
          .join(', ')}`,
      );
    }

    if (isBusy()) {
      blockedBy.push('a coordinator turn in flight');
    }

    const quietSeconds = await getLogQuietSeconds();

    if (quietSeconds !== null && quietSeconds < QUIET_WINDOW_SECONDS) {
      blockedBy.push('the log is not quiet yet');
    }

    if (blockedBy.length) {
      await notifyLongPending(current, blockedBy);

      return;
    }

    exiting = true;
    console.log(`[restart] safe window reached (requested at ${current.requestedAt.toISOString()}: ${current.reason})`);
    await onRestartWindow();
  };

  const timer = setInterval(() => {
    poll().catch(error => {
      console.error('[restart] poll failed:', error);
    });
  }, POLL_INTERVAL_MS);

  const consumer = startConsumer({
    name: 'restart',
    types: [SYSTEM_RESTART_REQUESTED],
    handler: async event => {
      // Replay guard: a request older than the newest completion was already
      // satisfied by a boot (the sweep wrote the completion).
      const lastCompletedSeq = await getLastEventSeq(SYSTEM_RESTART_COMPLETED);

      if (lastCompletedSeq !== null && lastCompletedSeq > event.seq) {
        return;
      }

      const force = event.payload.force === true || (pending?.force ?? false);

      pending = {
        seq: event.seq,
        userId: event.userId,
        threadId: event.threadId,
        reason: typeof event.payload.reason === 'string' ? event.payload.reason : 'restart',
        force,
        requestedAt: event.createdAt,
        forceApplied: false,
        notified: false,
      };

      console.log(`[restart] pending (seq=${event.seq}${force ? ', force' : ''}): ${pending.reason}`);
    },
  });

  return {
    name: consumer.name,
    stop: () => {
      clearInterval(timer);
      consumer.stop();
    },
  };
}
