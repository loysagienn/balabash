// Registry events: the log's record of a registry table changing (projects,
// scheduled tasks, app publications). The snapshot the console hydrates
// from is a projection of the log, so every change of a table it shows
// must be an event too, or the browser's copy goes stale until a reload.
// They are journaled right where the table changes (src/projects/tools.ts,
// src/schedule/tools.ts and heart.ts, src/apps/management.ts); the payload
// is the row as the snapshot shows it (src/api/contract.ts views with ISO
// dates), so a reducer upserts it as a whole. The table change has already
// happened when the event is written: a failure to journal is logged, never
// thrown back into the tool call or the request.

import { appendEvent } from './append.ts';
import { getThread } from './threads.ts';
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

export async function journalRegistryEvent<T extends RegistryEventType>(type: T, payload: EventPayloads[T], by: RegistryAuthor): Promise<void> {
  try {
    const thread = by.kind === 'thread' ? await getThread(by.threadId) : null;

    await appendEvent({
      type,
      ...(thread ? { actor: 'agent', agentName: thread.agent, threadId: thread.id } : { actor: by.kind === 'user' ? 'user' : 'system', threadId: null }),
      userId: by.userId,
      payload: payload as JsonObject,
    });
  } catch (error) {
    console.error(`[registry] failed to journal ${type}:`, error);
  }
}
