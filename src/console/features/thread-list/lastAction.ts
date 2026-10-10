// The last action of an active thread for its row ("npm run build",
// "Edit journal.md", "Waiting for the browser agent"): the newest telling
// event among those the store holds for the thread — the tail brings them
// for every thread while the tab is open; a thread with none loaded shows
// no action. A command or a tool goes into the row as a code chip, a
// progress note as text.

import type { ContentBlock, Event } from '../../../core/contract.ts';
import type { EventOf, EventType } from '../../../core/event-types.ts';
import { plainLine } from '../../lib/format/plain.ts';

export type LastAction = { last?: string; lastCode?: string };

// The last message of the main thread for its pinned row: the newest
// user.message or agent.message among the events the store holds — or the
// one the snapshot carried (threads.mainLastMessage), whichever is later
// by seq — whatever it carries: its first line of text, or the names of
// its attachments when it has no text (a photo from Telegram without a
// caption arrives with text: null), or an empty text — and its time. Null
// while the thread has no message anywhere.
export type LastMessage = { text: string; at: Date; seq: bigint };

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

// The words of a message for the row: its text as plain words (the
// Markdown marks off — a heading without its "#", a link by its text), or
// its attachments.
function messageText(text: string | null | undefined, attachments: readonly string[]): string {
  return clip(plainLine(text ?? '')) || clip(attachments.join(', '));
}

function blockAttachments(blocks: readonly ContentBlock[]): string[] {
  return blocks.flatMap(block =>
    block.type === 'image' ? ['image'] : block.type === 'file' ? ['file'] : block.type === 'resource_link' ? [block.name ?? block.uri] : [],
  );
}

function userAttachments(payload: EventOf<'user.message'>['payload']): string[] {
  if (Array.isArray(payload.files) && payload.files.length > 0) {
    return payload.files.map(file => file.originalFilename ?? (typeof file.contentType === 'string' && file.contentType.startsWith('image/') ? 'image' : 'file'));
  }

  return Array.isArray(payload.blocks) ? blockAttachments(payload.blocks) : [];
}

function messageOf(event: Event): LastMessage | null {
  if (is(event, 'user.message')) {
    return { text: messageText(event.payload.text, userAttachments(event.payload)), at: event.createdAt, seq: event.seq };
  }
  if (is(event, 'agent.message')) {
    const content = Array.isArray(event.payload.content) ? event.payload.content : [];
    const text = content.map(block => (block.type === 'text' && typeof block.text === 'string' ? block.text : '')).filter(Boolean).join('\n');

    return { text: messageText(text, blockAttachments(content)), at: event.createdAt, seq: event.seq };
  }

  return null;
}

// events — the thread's events in seq order; kept — the message the
// snapshot carried, if any (an event of another kind counts for nothing).
export function lastMessageOf(events: readonly Event[], kept: Event | null = null): LastMessage | null {
  const fallback = kept ? messageOf(kept) : null;

  for (let i = events.length - 1; i >= 0; i -= 1) {
    const message = messageOf(events[i]!);

    if (message) {
      return fallback && fallback.seq > message.seq ? fallback : message;
    }
  }

  return fallback;
}

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
