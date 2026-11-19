// The course of a thread as text — the value of `threads_get_transcript`.
// One line per event, oldest first: the event in the form of `Event`
// (events.ts) as JSON, condensed. The reader is any caller, not the thread
// itself, so every line names its author; what was cut is marked, and the
// seq of the line reads the event in full with `get_event`.
//
// What a line leaves out of `Event`: the stable id, the fields that are
// null, and the two thread ids where they name the thread being read — a
// line without `threadId` is the thread's own event, a line with one came
// from that thread.
//
// The size is bounded on three levels. A payload is condensed by the first
// measure its line fits under LINE_LIMIT with: long strings cut, long lists
// cut to their first items. A payload no measure fits gives way to its
// size alone. A page holds whole lines up to PAGE_LIMIT, taken from the
// newest event back — a line is never longer than a page, so a page with
// events to show always shows at least one and the reading moves on.

import type { Event as LogEvent } from '../core/contract.ts';

const PAGE_LIMIT = 50_000;
const LINE_LIMIT = 8_000;

// Longest string and longest list a payload keeps, from the roomy measure to
// the tight one.
const MEASURES = [
  { string: 2_000, list: 20 },
  { string: 400, list: 10 },
  { string: 100, list: 5 },
] as const;

type Measure = (typeof MEASURES)[number];

type Condensed = { value: unknown; cut: boolean };

function condense(value: unknown, measure: Measure): Condensed {
  if (typeof value === 'string') {
    return value.length > measure.string ? { value: `${value.slice(0, measure.string)}…`, cut: true } : { value, cut: false };
  }

  if (Array.isArray(value)) {
    const kept = value.slice(0, measure.list).map(item => condense(item, measure));
    const more = value.length - kept.length;

    return {
      value: more > 0 ? [...kept.map(item => item.value), `… ${more} more`] : kept.map(item => item.value),
      cut: more > 0 || kept.some(item => item.cut),
    };
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value).map(([key, item]) => [key, condense(item, measure)] as const);

    return {
      value: Object.fromEntries(entries.map(([key, item]) => [key, item.value])),
      cut: entries.some(([, item]) => item.cut),
    };
  }

  return { value, cut: false };
}

function line(threadId: string, event: LogEvent): string {
  const head = {
    seq: Number(event.seq),
    type: event.type,
    actor: event.actor,
    ...(event.agentName !== null ? { agentName: event.agentName } : {}),
    ...(event.threadId !== null && event.threadId !== threadId ? { threadId: event.threadId } : {}),
    ...(event.targetThreadId !== null && event.targetThreadId !== threadId ? { targetThreadId: event.targetThreadId } : {}),
    createdAt: event.createdAt.toISOString(),
  };

  for (const measure of MEASURES) {
    const { value, cut } = condense(event.payload, measure);
    const text = JSON.stringify({ ...head, ...(cut ? { truncated: true } : {}), payload: value });

    if (text.length <= LINE_LIMIT) {
      return text;
    }
  }

  return JSON.stringify({ ...head, truncated: true, payloadChars: JSON.stringify(event.payload).length });
}

export type TranscriptPage = {
  text: string;
  // How many of the events the text holds: the newest ones. Fewer than
  // given — the rest did not fit the page and is left to the next one.
  taken: number;
};

// The page of the events of the thread `threadId`, given oldest first.
export function transcriptPage(threadId: string, events: LogEvent[]): TranscriptPage {
  const lines: string[] = [];
  let size = 0;

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const text = line(threadId, events[index] as LogEvent);
    // A line and the break that joins it to the next one.
    const added = text.length + (lines.length ? 1 : 0);

    if (size + added > PAGE_LIMIT) {
      break;
    }

    lines.unshift(text);
    size += added;
  }

  return { text: lines.join('\n'), taken: lines.length };
}
