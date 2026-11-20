// Registry events: the log's record of a registry table changing (projects,
// scheduled tasks, app publications, the names of Settings on the user's
// row — settings.updated — and the open requests for installation
// credentials — secrets.requested / oauth_client.requested). The snapshot
// the console hydrates from is a projection of the log, so every change of
// a table it shows must be an event too, or the browser's copy goes stale
// until a reload.
// They are journaled where the table changes (src/projects/mutations.ts,
// src/schedule/tools.ts and heart.ts, src/apps/management.ts,
// src/capabilities/secret-requests.ts), in the same transaction as the
// change: the row and its event commit together or not
// at all, and the event's seq is allocated under the row lock the change
// holds, so two changes of one row reach the log in the order they reached
// the table — a reducer folding the tail never sees an older row after a
// newer one. The payload is the row as the snapshot shows it
// (src/api/contract.ts views with ISO dates), so a reducer upserts it as a
// whole.

import { appendEventIn, logTransaction } from './append.ts';
import type { Tx } from './append.ts';
import { notifyAppended } from './live.ts';
import type { EventPayloads, EventType } from './event-types.ts';
import type { JsonObject, TaskAuthor } from './contract.ts';

export type RegistryEventType = Extract<EventType, `project.${string}` | `schedule.task.${string}` | `app.${string}` | 'settings.updated' | 'secrets.requested' | 'oauth_client.requested'>;

// Who changed the registry: an agent through a tool call (the event is
// authored by its thread), a task acting in the main thread, the operator (no
// thread), or the core itself (the schedule heart consuming a one-shot).
export type RegistryAuthor =
  | { kind: 'thread'; workspaceId: string; threadId: string; task?: TaskAuthor }
  | { kind: 'user'; workspaceId: string }
  | { kind: 'system'; workspaceId: string };

async function registryEnvelope(tx: Tx, by: RegistryAuthor) {
  if (by.kind !== 'thread') {
    return { actor: by.kind };
  }
  if (by.task) {
    return { actor: 'task' as const, task: by.task, threadId: by.threadId };
  }

  const thread = await tx.thread.findUnique({ where: { id: by.threadId }, select: { id: true, agent: true } });
  return thread ? { actor: 'agent' as const, agentName: thread.agent, threadId: thread.id } : { actor: 'system' as const };
}

// Answers the seq of the event written — a change that answers a client
// can tell it where in the log its change stands (PATCH /settings does, so
// a tab applies the answer only ahead of the names its tail already
// brought) — or null when the append was a no-op.
export type RegistryJournal = <T extends RegistryEventType>(type: T, payload: EventPayloads[T], by: RegistryAuthor) => Promise<bigint | null>;

// One registry change: the table writes and the events recording them in
// one transaction (tx is the transaction's client — every write of the
// change goes through it), opened under the log lock (logTransaction), so
// the change's own row locks come after it. The live tail is told after
// the commit.
export async function registryMutation<T>(change: (tx: Tx, journal: RegistryJournal) => Promise<T>): Promise<T> {
  const appended: bigint[] = [];

  const result = await logTransaction(async tx => {
    const journal: RegistryJournal = async (type, payload, by) => {
      const appendResult = await appendEventIn(tx, {
        type,
        ...(await registryEnvelope(tx, by)),
        workspaceId: by.workspaceId,
        payload: payload as JsonObject,
      });

      if (!appendResult.written) {
        return null;
      }

      appended.push(appendResult.event.seq);

      return appendResult.event.seq;
    };

    return change(tx, journal);
  });

  for (const seq of appended) {
    notifyAppended(seq);
  }

  return result;
}
