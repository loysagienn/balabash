// Sessions of finished threads are deleted after a retention period. A
// thread's session lives in its SDK's own store (Claude: the CLI's
// transcript; Codex: the rollout) and the journal names it (session.sdk);
// once the thread is terminal the session has nothing left to resume and
// only takes space — gigabytes within weeks. Once a day the sweep finds the
// threads whose terminal is older than the retention period and whose named
// sessions are not yet journaled as deleted, deletes each through its SDK's
// own means (deleteClaudeSession / deleteCodexSession) and journals
// session.deleted into the thread — the fact that makes the sweep idempotent
// and visible. A session the store no longer has is journaled too (found:
// false), so nothing is looked for twice; a failed deletion is logged and
// tried again at the next pass.

import { Prisma } from '../../prisma-generated/client.ts';
import { prisma } from '../db/client.ts';
import { config } from '../config/index.ts';
import { appendEvent } from '../core/append.ts';
import { deleteClaudeSession } from '../harness/claude-sdk/session-store.ts';
import { deleteCodexSession } from '../harness/codex-sdk/session-store.ts';

const FIRST_PASS_DELAY_MS = 5 * 60 * 1000;
const PASS_INTERVAL_MS = 24 * 60 * 60 * 1000;

export type Sdk = 'claude' | 'codex';

export type ExpiredSession = {
  threadId: string;
  workspaceId: string;
  agent: string;
  sdk: Sdk;
  sdkSessionId: string;
};

export type SessionDeleters = Record<Sdk, (sdkSessionId: string) => Promise<boolean>>;

export const SDK_DELETERS: SessionDeleters = { claude: deleteClaudeSession, codex: deleteCodexSession };

export function retentionCutoff(now: Date = new Date(), days: number = config.sessionRetentionDays): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

// Every (thread, session) the journal named for a thread whose terminal was
// written before `cutoff`, minus those already journaled as deleted. A
// thread may have named several sessions over its life (the id changed);
// all of them go.
export async function listExpiredSessions(cutoff: Date): Promise<ExpiredSession[]> {
  const rows = await prisma.$queryRaw<{ threadId: string; workspaceId: string; agent: string; sdk: string; sdkSessionId: string }[]>`
    SELECT DISTINCT ON (s.thread_id, s.payload->>'sdkSessionId')
           s.thread_id AS "threadId", t.workspace_id AS "workspaceId", t.agent,
           s.payload->>'sdk' AS sdk, s.payload->>'sdkSessionId' AS "sdkSessionId"
    FROM events s
    JOIN threads t ON t.id = s.thread_id
    JOIN events term ON term.seq = t.terminal_seq
    WHERE s.type = 'session.sdk'
      AND t.status <> 'active'
      AND term.created_at < ${cutoff}
      AND NOT EXISTS (
        SELECT 1 FROM events d
        WHERE d.thread_id = s.thread_id AND d.type = 'session.deleted'
          AND d.payload->>'sdkSessionId' = s.payload->>'sdkSessionId'
      )
    ORDER BY s.thread_id, s.payload->>'sdkSessionId', s.seq`;

  return rows
    .filter(row => (row.sdk === 'claude' || row.sdk === 'codex') && typeof row.sdkSessionId === 'string' && row.sdkSessionId)
    .map(row => ({ ...row, sdk: row.sdk as Sdk }));
}

export type SweepResult = { deleted: number; missing: number; failed: number };

// One pass: delete every expired session and journal the fact. Deleters
// are injectable for tests; the app passes the SDKs' own.
export async function sweepExpiredSessions(cutoff: Date, deleters: SessionDeleters = SDK_DELETERS): Promise<SweepResult> {
  const result: SweepResult = { deleted: 0, missing: 0, failed: 0 };

  for (const expired of await listExpiredSessions(cutoff)) {
    let found: boolean;

    try {
      found = await deleters[expired.sdk](expired.sdkSessionId);
    } catch (error) {
      console.error(`[session-cleanup] failed to delete ${expired.sdk} session ${expired.sdkSessionId} of thread ${expired.threadId}:`, error);
      result.failed += 1;

      continue;
    }

    await appendEvent({
      type: 'session.deleted',
      actor: 'system',
      workspaceId: expired.workspaceId,
      threadId: expired.threadId,
      payload: { sdk: expired.sdk, sdkSessionId: expired.sdkSessionId, found },
    });

    if (found) {
      result.deleted += 1;
    } else {
      result.missing += 1;
    }
  }

  return result;
}

// The service: a pass a few minutes after boot (the boot itself has enough
// to do), then one a day. Not a log consumer, but it stops like one.
export function startSessionCleanup(): { name: string; stop: () => void } {
  let stopped = false;
  let timer: NodeJS.Timeout;

  const loop = async () => {
    try {
      const days = config.sessionRetentionDays;
      const result = await sweepExpiredSessions(retentionCutoff(new Date(), days));

      if (result.deleted + result.missing + result.failed > 0) {
        console.log(`[session-cleanup] sessions of threads finished over ${days} days ago: ${result.deleted} deleted, ${result.missing} already gone, ${result.failed} failed`);
      }
    } catch (error) {
      console.error('[session-cleanup] pass failed:', error);
    }

    if (!stopped) {
      timer = setTimeout(loop, PASS_INTERVAL_MS);
    }
  };

  timer = setTimeout(loop, FIRST_PASS_DELAY_MS);

  return {
    name: 'session-cleanup',
    stop: () => {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
