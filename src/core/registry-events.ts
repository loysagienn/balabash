// Registry events: the log's record of a registry table changing (projects,
// scheduled tasks, app publications). The snapshot the console hydrates
// from is a projection of the log, so every change of a table it shows
// must be an event too, or the browser's copy goes stale until a reload.
// They are journaled where the table changes (src/projects/tools.ts,
// src/schedule/tools.ts and heart.ts, src/apps/management.ts), in the same
// transaction as the change: the row and its event commit together or not
// at all, and the event's seq is allocated under the row lock the change
// holds, so two changes of one row reach the log in the order they reached
// the table — a reducer folding the tail never sees an older row after a
// newer one. The payload is the row as the snapshot shows it
// (src/api/contract.ts views with ISO dates), so a reducer upserts it as a
// whole.

import { prisma } from '../db/client.ts';
import { appendEventIn } from './append.ts';
import type { Tx } from './append.ts';
import { notifyAppended } from './live.ts';
import type { EventPayloads, EventType } from './event-types.ts';
import type { JsonObject } from './contract.ts';

export type RegistryEventType = Extract<EventType, `project.${string}` | `schedule.task.${string}` | `app.${string}`>;

// Who changed the registry: an agent through a tool call (the event is
// authored by its thread), the operator from the console (actor user, no
// thread), or the core itself (the schedule heart consuming a one-shot).
export type RegistryAuthor =
  | { kind: 'thread'; userId: string; threadId: string }
  | { kind: 'user'; userId: string }
  | { kind: 'system'; userId: string };

export type RegistryJournal = <T extends RegistryEventType>(type: T, payload: EventPayloads[T], by: RegistryAuthor) => Promise<void>;

// One registry change: the table writes and the events recording them in
// one transaction (tx is the transaction's client — every write of the
// change goes through it). The live tail is told after the commit.
export async function registryMutation<T>(change: (tx: Tx, journal: RegistryJournal) => Promise<T>): Promise<T> {
  const appended: bigint[] = [];

  const result = await prisma.$transaction(async tx => {
    const journal: RegistryJournal = async (type, payload, by) => {
      const thread = by.kind === 'thread' ? await tx.thread.findUnique({ where: { id: by.threadId }, select: { id: true, agent: true } }) : null;

      const appendResult = await appendEventIn(tx, {
        type,
        ...(thread ? { actor: 'agent', agentName: thread.agent, threadId: thread.id } : { actor: by.kind === 'user' ? 'user' : 'system', threadId: null }),
        userId: by.userId,
        payload: payload as JsonObject,
      });

      if (appendResult.written) {
        appended.push(appendResult.event.seq);
      }
    };

    return change(tx, journal);
  });

  for (const seq of appended) {
    notifyAppended(seq);
  }

  return result;
}
