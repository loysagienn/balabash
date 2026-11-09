// Threads survive an app restart: a thread's run is process memory, but its
// session lives on in its SDK's own store (Claude: the transcript the CLI
// keeps; Codex: the rollout in CODEX_HOME). The journal names that session
// (session.sdk); on boot a thread whose session is named is given its run
// back — the same run spawnAgentRun builds from the thread's thread.started,
// with the session resumed instead of started (ctx.resume). A thread whose
// session is not named (it died before the SDK announced one) has nothing to
// resume and is tombstoned as before.
//
// Two boot phases: the sweep runs before anything can address a thread (the
// unresumable go); the resume runs once the agent catalog and the tool
// servers are loaded and before the router starts — the router then finds
// the runs registered and delivers what arrived meanwhile.

import type { RunResume, Thread } from '../core/contract.ts';
import { appendEvent } from '../core/append.ts';
import { getLastThreadEvent, getWorkspaceEvent } from '../core/events.ts';
import { THREAD_CANCELLED } from '../core/envelope.ts';
import { getThread, listActiveChildIds, listActiveChildThreads, tombstoneActiveThreads } from '../core/threads.ts';
import { registerRun } from '../runtime/runs.ts';
import { spawnAgentRun } from './agent-runtime.ts';

export type SavedSession = Omit<RunResume, 'childThreadIds'>;

// The thread's session in its SDK's store, as the journal last named it, and
// whether a turn was in flight when the journal last heard of it (the last
// session.state is `run`); null when no session was ever named.
export async function savedSessionOf(threadId: string): Promise<SavedSession | null> {
  const sdk = await getLastThreadEvent(threadId, 'session.sdk');
  const sdkSessionId = sdk?.payload.sdkSessionId;

  if (typeof sdkSessionId !== 'string' || !sdkSessionId) {
    return null;
  }

  const state = await getLastThreadEvent(threadId, 'session.state');

  return { sdkSessionId, interrupted: state?.payload.state === 'run' };
}

// Boot, phase one: tombstone the active run threads that have no saved
// session to resume. Returns how many were cancelled (cascades excluded).
export async function tombstoneUnresumableThreads(): Promise<number> {
  return tombstoneActiveThreads('process_restart', async thread => (await savedSessionOf(thread.id)) !== null);
}

async function cancel(thread: Thread, reason: string): Promise<void> {
  await appendEvent({
    type: THREAD_CANCELLED,
    actor: 'system',
    workspaceId: thread.workspaceId,
    threadId: thread.id,
    payload: { reason },
  });
}

// Boot, phase two: give every surviving run thread its run back. A thread a
// cascade took in the meantime is skipped; a run that cannot be built fails
// its thread the ordinary way (spawnAgentRun journals the terminal).
export async function resumeThreadRuns(): Promise<{ resumed: number; failed: number }> {
  let resumed = 0;
  let failed = 0;

  for (const listed of await listActiveChildThreads()) {
    const thread = await getThread(listed.id);

    if (!thread || thread.status !== 'active') {
      continue;
    }

    try {
      const saved = await savedSessionOf(thread.id);
      const startedEvent = await getWorkspaceEvent(thread.workspaceId, thread.createdSeq);

      if (!saved || !startedEvent) {
        await cancel(thread, 'process_restart');
        failed += 1;

        continue;
      }

      const resume: RunResume = { ...saved, childThreadIds: await listActiveChildIds(thread.id) };

      await appendEvent({
        type: 'session.resumed',
        actor: 'agent',
        agentName: thread.agent,
        workspaceId: thread.workspaceId,
        threadId: thread.id,
        payload: { sdkSessionId: saved.sdkSessionId, interrupted: saved.interrupted },
      });

      const run = await spawnAgentRun(thread, startedEvent, resume);

      if (run) {
        registerRun(thread.id, run);
        resumed += 1;
      } else {
        failed += 1;
      }
    } catch (error) {
      console.error(`[resume:${thread.id}] resume failed:`, error);
      await cancel(thread, 'resume_failed').catch(() => {});
      failed += 1;
    }
  }

  return { resumed, failed };
}
