// Keeping the app's session list short: of the finished threads' sessions
// only the newest KEEP_VISIBLE_FINISHED_SESSIONS stay listed — the older ones
// are archived in the app (the CLI's own POST …/archive), once each, right
// after a terminal delivery. Sessions of active threads are never
// touched; the archived session remains readable in the app's archive.

import { prisma } from '../../db/client.ts';
import { archiveRemoteSession } from './session.ts';

export const KEEP_VISIBLE_FINISHED_SESSIONS = 20;

type Candidate = { threadId: string; cseId: string };

let sweepInFlight: Promise<void> | null = null;

// Archive every finished thread's session older than the newest `keep`
// finished ones. One sweep at a time: a sweep started while another runs
// joins it (the running one sees the same rows a moment later).
export function archiveOlderSessions(keep = KEEP_VISIBLE_FINISHED_SESSIONS): Promise<void> {
  if (!sweepInFlight) {
    sweepInFlight = sweep(keep).finally(() => {
      sweepInFlight = null;
    });
  }

  return sweepInFlight;
}

async function sweep(keep: number): Promise<void> {
  // Finished threads with a session, minus the newest `keep` of them (by
  // terminal order, archived or not), minus the ones archived already. With
  // fewer than `keep` finished threads the threshold is NULL and nothing
  // qualifies.
  const candidates = await prisma.$queryRaw<Candidate[]>`
    SELECT s.thread_id AS "threadId", s.cse_id AS "cseId"
    FROM ccr_sessions s
    JOIN threads t ON t.id = s.thread_id
    WHERE t.status <> 'active'
      AND s.archived_at IS NULL
      AND t.terminal_seq < (
        SELECT t2.terminal_seq
        FROM threads t2
        JOIN ccr_sessions s2 ON s2.thread_id = t2.id
        WHERE t2.status <> 'active'
        ORDER BY t2.terminal_seq DESC
        LIMIT 1 OFFSET ${keep - 1}
      )
    ORDER BY t.terminal_seq`;

  for (const { threadId, cseId } of candidates) {
    try {
      const outcome = await archiveRemoteSession(cseId);

      await prisma.ccrSession.update({ where: { threadId }, data: { archivedAt: new Date() } });
      console.log(
        `[ccr] ${outcome === 'gone' ? 'session already deleted' : 'archived session'} thread=${threadId} cse=${cseId}`,
      );
    } catch (error) {
      // Left for the next sweep; the app merely lists one session too many.
      console.error(`[ccr] archive failed thread=${threadId} cse=${cseId}:`, error);
    }
  }
}
