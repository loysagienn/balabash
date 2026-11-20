// The restart module: turns a system.restart.requested event into a clean
// process exit inside a safe window, so the supervisor (supervisor.js) boots
// the freshly built bundle. Restart is the only reload — hot-reload is gone
// by design.
//
// The safe window is structural first, heuristic second:
// - no agent turn in flight in any run thread of any workspace (the
//   journal's last session.state; a thread between turns is no obstacle —
//   it keeps its SDK session and its run resumes after the restart,
//   src/capabilities/resume-runs.ts; a remote agent's thread — the mirror
//   of a session elsewhere, no run here — never blocks); force skips this
//   wait and cuts the turns in flight, their threads resume with a note,
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
import { appendEvent, appendEventIn, logTransaction } from '../core/append.ts';
import { startConsumer } from '../core/consumers.ts';
import type { Consumer } from '../core/consumers.ts';
import {
  SYSTEM_EXCEPTION,
  SYSTEM_RESTART_COMPLETED,
  SYSTEM_RESTART_REQUESTED,
  THREAD_NOTIFICATION,
} from '../core/envelope.ts';
import { getEventsAfter, getLastEventSeq, getLogQuietSeconds } from '../core/events.ts';
import { notifyAppended } from '../core/live.ts';
import { getMainThread, listBusyRunThreads } from '../core/threads.ts';
import type { PendingRestartView } from '../api/contract.ts';

// Kept in sync with supervisor.js by hand — the supervisor is dependency-free
// and never imports the bundle.
export const RESTART_EXIT_CODE = 42;

const ROLLBACK_MARKER_PATH = path.resolve('data', 'supervisor', 'rollback.json');

const POLL_INTERVAL_MS = 3_000;
const QUIET_WINDOW_SECONDS = 20;
const PENDING_NOTIFY_AFTER_MS = 5 * 60_000;

type PendingRestart = {
  seq: bigint;
  workspaceId: string | null;
  threadId: string | null;
  reason: string;
  // The agent of the requesting thread, as the request names it.
  requestedBy: string | null;
  force: boolean;
  requestedAt: Date;
  notified: boolean;
  // What the newest poll found in the way — every workspace's threads with
  // an agent turn in flight, with their owner; null before the first poll.
  waiting: {
    threads: { id: string; title: string | null; agent: string; workspaceId: string }[];
    secretaryTurn: boolean;
    workspaceJob: boolean;
    logQuiet: boolean;
  } | null;
};

let pending: PendingRestart | null = null;

// The coordinator's status tail shows this (volatile, outside the cache
// head); the console's System screen shows what the restart waits for. The
// view is the workspace's: the request's words and thread only when the
// request is its own, the threads in the way only its own — another
// workspace's are a count (src/api/contract.ts PendingRestartView).
export function getPendingRestart(workspaceId: string): PendingRestartView | null {
  if (!pending) {
    return null;
  }

  const { seq, reason, requestedAt, requestedBy, threadId, force, waiting } = pending;
  const own = pending.workspaceId === workspaceId;

  return {
    seq: Number(seq),
    own,
    reason: own ? reason : null,
    requestedAt,
    requestedBy: own ? requestedBy : null,
    threadId: own ? threadId : null,
    force,
    waiting: waiting
      ? {
          threads: waiting.threads.filter(thread => thread.workspaceId === workspaceId).map(({ id, title, agent }) => ({ id, title, agent })),
          otherThreads: waiting.threads.filter(thread => thread.workspaceId !== workspaceId).length,
          secretaryTurn: waiting.secretaryTurn,
          workspaceJob: waiting.workspaceJob,
          logQuiet: waiting.logQuiet,
        }
      : null,
  };
}

// The request of a restart: the event is the request and the log is its
// audit trail; the module's consumer picks it up and waits for the window.
// Written on behalf of the requesting thread, which gets the completion.
// The answer says what the restart now pending is: a forced request stays
// forced whatever a later one asks (the consumer below), so the requests
// since the last completion are read from the log — this one among them.
// The reading and the append are one transaction of the log: a request is
// recorded together with its answer, or the call fails and nothing is
// recorded.
export async function requestRestart(request: {
  workspaceId: string;
  threadId: string;
  reason: string;
  force: boolean;
  // The agent of the requesting thread.
  requestedBy: string | null;
}): Promise<{ forced: boolean }> {
  const { seq, forced } = await logTransaction(async tx => {
    const appended = await appendEventIn(tx, {
      type: SYSTEM_RESTART_REQUESTED,
      actor: 'system',
      workspaceId: request.workspaceId,
      threadId: request.threadId,
      payload: {
        reason: request.reason,
        ...(request.force ? { force: true } : {}),
        ...(request.requestedBy ? { requestedBy: request.requestedBy } : {}),
      },
    });

    // A request is no terminal and no command of a thread: it is written.
    const written = appended.written ? appended.event.seq : null;

    if (request.force) {
      return { seq: written, forced: true };
    }

    const lastCompletedSeq = (await getLastEventSeq(SYSTEM_RESTART_COMPLETED, tx)) ?? 0n;
    const pendingRequests = await getEventsAfter(lastCompletedSeq, { types: [SYSTEM_RESTART_REQUESTED], limit: 50, reader: tx });

    return { seq: written, forced: pendingRequests.some(event => event.payload.force === true) };
  });

  if (seq !== null) {
    notifyAppended(seq);
  }

  return { forced };
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
    if (!request.workspaceId) {
      continue;
    }

    const target = request.threadId ?? (await getMainThread(request.workspaceId))?.id ?? null;

    if (!target) {
      continue;
    }

    await appendEvent({
      type: SYSTEM_RESTART_COMPLETED,
      actor: 'system',
      workspaceId: request.workspaceId,
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
      workspaceId: null,
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
      workspaceId: null,
      payload: { scope: 'migrate-deploy', error: migrationsError },
    });
  }
}

type RestartModuleHooks = {
  // In-memory truth about coordinator turns in flight — injected by the
  // composition root (the runtime does not know the coordinator, §3).
  isBusy(): boolean;
  // In-memory truth about what runs outside any agent turn — the runs of
  // programs with the calls and commands they started, the former workspace
  // jobs — injected likewise (the runtime does not know the schedule or the
  // catalog). None of it survives a restart, so the safe window waits for
  // it, under force too: force cuts agent turns, not this work.
  hasActiveJobs(): boolean;
  // In-memory truth about the remote engine (src/remote): a verb of a
  // driver in flight or an inbound wake not yet served. Its state is
  // durable and a replay after the restart is safe, but a verb half-way
  // through is better finished than repeated; the safe window waits.
  hasRemoteWork?(): boolean;
  // Graceful shutdown ending in process.exit(RESTART_EXIT_CODE).
  onRestartWindow(): Promise<void>;
  // How often the safe window is polled; the tests shorten it.
  pollIntervalMs?: number;
};

export function startRestartModule({ isBusy, hasActiveJobs, hasRemoteWork, onRestartWindow, pollIntervalMs = POLL_INTERVAL_MS }: RestartModuleHooks): Consumer {
  let exiting = false;

  const notifyLongPending = async (current: PendingRestart, blockedBy: string[]): Promise<void> => {
    if (current.notified || !current.workspaceId || Date.now() - current.requestedAt.getTime() < PENDING_NOTIFY_AFTER_MS) {
      return;
    }

    current.notified = true;

    const main = await getMainThread(current.workspaceId);

    if (!main) {
      return;
    }

    await appendEvent({
      type: THREAD_NOTIFICATION,
      actor: 'system',
      workspaceId: current.workspaceId,
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

    // Agent turns in flight hold the window; force does not wait for them —
    // the restart cuts them off and their threads resume with a note.
    const busyThreads = current.force ? [] : await listBusyRunThreads();
    const blockedBy: string[] = [];

    if (busyThreads.length) {
      blockedBy.push(
        `an agent turn in flight in ${busyThreads.length} thread(s): ${busyThreads
          .slice(0, 5)
          .map(thread => thread.title ?? thread.agent)
          .join(', ')}`,
      );
    }

    const secretaryTurn = isBusy();

    if (secretaryTurn) {
      blockedBy.push('a secretary turn in flight');
    }

    const workspaceJob = hasActiveJobs();

    if (workspaceJob) {
      blockedBy.push('a workspace job still running');
    }

    if (hasRemoteWork?.()) {
      blockedBy.push('a remote thread’s command in flight');
    }

    const quietSeconds = await getLogQuietSeconds();
    const logQuiet = !(quietSeconds !== null && quietSeconds < QUIET_WINDOW_SECONDS);

    if (!logQuiet) {
      blockedBy.push('the log is not quiet yet');
    }

    current.waiting = {
      threads: busyThreads.map(thread => ({ id: thread.id, title: thread.title, agent: thread.agent, workspaceId: thread.workspaceId })),
      secretaryTurn,
      workspaceJob,
      logQuiet,
    };

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
  }, pollIntervalMs);

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
        workspaceId: event.workspaceId,
        threadId: event.threadId,
        reason: typeof event.payload.reason === 'string' ? event.payload.reason : 'restart',
        requestedBy: typeof event.payload.requestedBy === 'string' ? event.payload.requestedBy : null,
        force,
        requestedAt: event.createdAt,
        notified: false,
        waiting: null,
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
