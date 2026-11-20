import type { Event } from '../core/contract.ts';
import { taskAuthorLabel } from './task-author.ts';

export function restartRequester(event: Pick<Event, 'agentName' | 'task' | 'payload'>): string | null {
  if (event.task) return taskAuthorLabel(event.task.slug);
  // Requests written by main before catalog ports recorded the name in the payload.
  return event.agentName ?? (typeof event.payload.requestedBy === 'string' ? event.payload.requestedBy : null);
}
