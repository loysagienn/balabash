// The event of the workspace log as a value of the catalog, and the root
// capability that loads one. An event may belong to no thread, so the
// capability lies in the root, not under `threads`.

import { z } from 'zod';
import { CapabilityError, JsonObject, capability, namedType } from '../catalog/index.ts';
import type { Event as LogEvent } from '../core/contract.ts';
import { getWorkspaceEvent } from '../core/events.ts';

export const Event = namedType(
  'Event',
  { description: 'One event of the workspace log.' },
  z.strictObject({
    seq: z.int().describe('Position in the log.'),
    id: z.string().describe('Stable id.'),
    type: z.string(),
    actor: z.enum(['user', 'system', 'agent']),
    agentName: z.string().nullable().describe('Set when actor is "agent".'),
    threadId: z.string().nullable().describe('Thread of the author; null outside threads.'),
    targetThreadId: z.string().nullable().describe('Thread the event is addressed to.'),
    payload: JsonObject.describe('Form set by `type`.'),
    createdAt: z.string().describe('ISO 8601.'),
  }),
);

export type EventValue = z.input<typeof Event>;

// The event as the log keeps it, in the form of the catalog: the payload is
// carried verbatim, whatever its size.
export function eventValue(event: LogEvent): EventValue {
  return {
    seq: Number(event.seq),
    id: event.id,
    type: event.type,
    actor: event.actor,
    agentName: event.agentName,
    threadId: event.threadId,
    targetThreadId: event.targetThreadId,
    payload: event.payload,
    createdAt: event.createdAt.toISOString(),
  };
}

export const getEvent = capability({
  name: 'get_event',
  summary: 'Load one event of the workspace log by its seq',
  description: 'Load one event of the workspace log by its seq.',
  input: z.strictObject({ seq: z.int() }),
  output: Event,
  async run({ seq }, { caller }) {
    // No event has a seq below 1; an event of another workspace answers the
    // same as a missing one.
    const event = seq >= 1 ? await getWorkspaceEvent(caller.workspaceId, BigInt(seq)) : null;

    if (!event) {
      throw new CapabilityError('not_found', `There is no event with seq ${seq} in the workspace.`);
    }

    return eventValue(event);
  },
});
