// The last action of an active thread for its row ("npm run build",
// "Edit journal.md", "Waiting for the browser agent"): the newest telling
// event among those the store holds for the thread — the tail brings them
// for every thread while the tab is open; a thread with none loaded shows
// no action. A command or a tool goes into the row as a code chip, a
// progress note as text.

import type { Event } from '../../../core/contract.ts';
import type { EventOf, EventType } from '../../../core/event-types.ts';

export type LastAction = { last?: string; lastCode?: string };

const MAX = 80;

function clip(text: string): string {
  const line = text.trim().split('\n')[0] ?? '';

  return line.length > MAX ? `${line.slice(0, MAX - 1)}…` : line;
}

function basename(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}

function fromTool(payload: EventOf<'session.tool.started'>['payload']): LastAction {
  const { name, input } = payload;
  const command = input.command;
  const path = input.file_path ?? input.path ?? input.notebook_path;

  if ((name === 'Bash' || name === 'Shell') && typeof command === 'string' && command.trim()) {
    return { lastCode: clip(command) };
  }
  if (typeof path === 'string' && path) {
    return { lastCode: `${name} ${basename(path)}` };
  }
  if (name === 'FileChange' && Array.isArray(input.changes)) {
    const first = input.changes[0];
    const file = first && typeof first === 'object' && !Array.isArray(first) && typeof first.path === 'string' ? basename(first.path) : null;

    return { lastCode: file ? `Edit ${file}` : 'Edit files' };
  }

  return { lastCode: name };
}

const is = <T extends EventType>(event: Event, type: T): event is Event & EventOf<T> => event.type === type;

// events — the thread's events in seq order (store/feed selectors).
export function lastActionOf(events: readonly Event[]): LastAction | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;

    if (is(event, 'session.tool.started')) {
      return fromTool(event.payload);
    }
    if (is(event, 'tool.call.started')) {
      return { lastCode: event.payload.functionName };
    }
    if (is(event, 'thread.progress')) {
      return event.payload.text.trim() ? { last: clip(event.payload.text) } : null;
    }
    if (is(event, 'session.task.started')) {
      return { last: clip(event.payload.description) };
    }
  }

  return null;
}
