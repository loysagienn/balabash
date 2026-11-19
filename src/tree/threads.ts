// The node `threads`: reading the threads of the workspace in layers — the
// list, one thread with the summary it left, its course as a condensed
// transcript, its events as data.

import { z } from 'zod';
import { CapabilityError, FileRef, capability, namedType, node, type Caller } from '../catalog/index.ts';
import type { Thread as ThreadRecord } from '../core/contract.ts';
import { getTranscript, getWorkspaceEventSeqs, listThreadEvents } from '../core/events.ts';
import { getThread, listThreads } from '../core/threads.ts';
import { buildTranscript } from '../harness/openai/transcript.ts';
import { cursorSeq, page, seqCursor } from './cursor.ts';
import { Event, eventValue } from './events.ts';
import { workspaceFileRefs } from './files.ts';

const THREAD_STATUSES = ['active', 'completed', 'failed', 'cancelled'] as const;

export const Thread = namedType(
  'Thread',
  { description: 'One thread of the workspace, without its summary.' },
  z.strictObject({
    threadId: z.string(),
    parentThreadId: z.string().nullable().describe('null for the main thread of the workspace.'),
    agent: z.string().describe('Name of the agent that runs the thread.'),
    title: z.string().nullable(),
    description: z
      .string()
      .nullable()
      .describe(
        'What the thread wrote about itself when it completed; null for an active thread and for one ended from outside.',
      ),
    status: z.enum(THREAD_STATUSES),
    headless: z.boolean().describe('true: no conversation with the user; the thread talks only to its parent.'),
    remote: z.boolean().describe('true: the thread mirrors a session of an agent in an external system.'),
    createdAt: z.string().describe('ISO 8601.'),
    updatedAt: z.string().describe('ISO 8601.'),
  }),
);

export type ThreadValue = z.input<typeof Thread>;

export function threadValue(thread: ThreadRecord): ThreadValue {
  return {
    threadId: thread.id,
    parentThreadId: thread.parentId,
    agent: thread.agent,
    title: thread.title,
    description: thread.description,
    status: thread.status,
    headless: thread.headless,
    remote: thread.remote,
    createdAt: thread.createdAt.toISOString(),
    updatedAt: thread.updatedAt.toISOString(),
  };
}

// A thread of the caller's workspace; a thread of another workspace answers
// the same as a missing one.
async function workspaceThread(caller: Caller, threadId: string): Promise<ThreadRecord> {
  const thread = await getThread(threadId);

  if (!thread || thread.workspaceId !== caller.workspaceId) {
    throw new CapabilityError('not_found', `There is no thread "${threadId}" in the workspace.`);
  }

  return thread;
}

const dateTime = z.iso.datetime({ offset: true });

// A moment of a filter. The signature cannot print a format, so the action
// checks it: an explicit offset is required — a time without one would mean
// the clock of the server.
function moment(field: string, value: string | undefined): Date | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!dateTime.safeParse(value).success) {
    throw new CapabilityError(
      'invalid_input',
      `${field} is not an ISO 8601 date-time with an offset: pass a value like 2026-01-31T09:00:00Z or 2026-01-31T09:00:00+03:00.`,
    );
  }

  return new Date(value);
}

const list = capability({
  name: 'list',
  summary: 'List the threads of the workspace, without summaries',
  description: 'List the threads of the workspace, newest first, without their summaries.',
  input: z.strictObject({
    status: z.enum(THREAD_STATUSES).optional(),
    createdAtGte: z.string().describe('Started at or after this ISO 8601 time.').optional(),
    createdAtLte: z.string().describe('Started at or before this ISO 8601 time.').optional(),
    limit: z.int().min(1).max(1000).default(100),
    cursor: z.string().optional(),
  }),
  output: z.strictObject({ threads: z.array(Thread), nextCursor: z.string().nullable() }),
  async run(input, { caller }) {
    const createdAtGte = moment('createdAtGte', input.createdAtGte);
    const createdAtLte = moment('createdAtLte', input.createdAtLte);
    const beforeCreatedSeq = cursorSeq(input.cursor);
    // The order is the order of the log: a thread is as new as its
    // thread.started.
    const found = await listThreads(caller.workspaceId, {
      order: 'desc',
      limit: input.limit + 1,
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(createdAtGte !== undefined ? { createdAtGte } : {}),
      ...(createdAtLte !== undefined ? { createdAtLte } : {}),
      ...(beforeCreatedSeq !== undefined ? { beforeCreatedSeq } : {}),
    });
    const { rows, nextCursor } = page(found, input.limit, thread => thread.createdSeq);

    return { threads: rows.map(threadValue), nextCursor };
  },
});

const get = capability({
  name: 'get',
  summary: 'Read one thread with the summary it left',
  description:
    'Read one thread with the summary it left. A thread that has not ended, or was ended from outside, has no summary.',
  input: z.strictObject({ threadId: z.string() }),
  output: z.strictObject({
    thread: Thread,
    summary: z
      .strictObject({
        text: z.string(),
        files: z.array(FileRef).describe('Files that belong with the report.'),
        refs: z.array(z.int()).describe('Seqs of the events the report refers to.'),
      })
      .nullable(),
  }),
  async run({ threadId }, { caller }) {
    const thread = await workspaceThread(caller, threadId);
    const { summary } = thread;

    if (!summary) {
      return { thread: threadValue(thread), summary: null };
    }

    // The summary keeps its files by id and its references by the stable id
    // of an event; the value gives what a caller can act on — a reference of
    // a file and the seq `get_event` takes.
    const refs = summary.refs ?? [];
    const seqs = await getWorkspaceEventSeqs(caller.workspaceId, refs);

    return {
      thread: threadValue(thread),
      summary: {
        text: summary.text,
        files: await workspaceFileRefs(caller.workspaceId, summary.fileIds ?? []),
        refs: refs.flatMap(ref => {
          const seq = seqs.get(ref);

          return seq === undefined ? [] : [Number(seq)];
        }),
      },
    };
  },
});

const getTranscriptPage = capability({
  name: 'get_transcript',
  summary: 'Read the course of a thread as a condensed transcript',
  description:
    'Read the course of a thread as a condensed transcript: the events it authored and the events addressed to it, each with its seq, long contents shortened. Pages go from the newest events to older ones.',
  input: z.strictObject({
    threadId: z.string(),
    limit: z.int().min(1).max(400).default(100).describe('Events per page; a page may hold fewer.'),
    cursor: z.string().optional(),
  }),
  output: z.strictObject({
    transcript: z.string().describe('The events of the page, in chronological order.'),
    nextCursor: z.string().nullable(),
  }),
  async run({ threadId, limit, cursor }, { caller }) {
    const thread = await workspaceThread(caller, threadId);
    const beforeSeq = cursorSeq(cursor);
    // The newest events before the cursor, oldest first; one over the limit
    // only tells that the thread goes further back.
    const found = await getTranscript(thread.id, {
      last: limit + 1,
      ...(beforeSeq !== undefined ? { beforeSeq } : {}),
    });
    const events = found.length > limit ? found.slice(1) : found;
    // The transcript has a size budget of its own, filled from the newest
    // event back: what did not fit is left to the next page.
    const transcript = buildTranscript(events);
    const oldest =
      transcript.dropped && transcript.oldestSeq !== null
        ? transcript.oldestSeq
        : found.length > limit
          ? events[0]?.seq
          : undefined;

    return { transcript: transcript.text, nextCursor: oldest === undefined ? null : seqCursor(oldest) };
  },
});

const getEvents = capability({
  name: 'get_events',
  summary: 'Get the events of a thread as data, filtered by type',
  description:
    'Get the events of a thread in full, as data: the events it authored and the events addressed to it. Pages go from the newest events to older ones. To read the course of a thread, `threads_get_transcript` is cheaper.',
  input: z.strictObject({
    threadId: z.string(),
    types: z.array(z.string()).describe('Only events of these types.').optional(),
    limit: z.int().min(1).max(200).default(50),
    cursor: z.string().optional(),
  }),
  output: z.strictObject({
    events: z.array(Event).describe('Newest first.'),
    nextCursor: z.string().nullable(),
  }),
  async run({ threadId, types, limit, cursor }, { caller }) {
    const thread = await workspaceThread(caller, threadId);
    const beforeSeq = cursorSeq(cursor);
    const found = await listThreadEvents(thread.id, {
      limit: limit + 1,
      ...(beforeSeq !== undefined ? { beforeSeq } : {}),
      ...(types !== undefined ? { types } : {}),
    });
    const { rows, nextCursor } = page(found, limit, event => event.seq);

    return { events: rows.map(eventValue), nextCursor };
  },
});

export const threads = node({
  name: 'threads',
  summary:
    'The threads of the workspace: who worked on what and how it ended. Come here to recover past work or the context a thread id points to.',
  guide: [
    {
      text: 'Read in layers, cheapest first: `threads_list` finds the thread, `threads_get` gives its summary, `threads_get_transcript` its course.',
    },
    { text: 'Any event of a transcript reads in full with `get_event` by its seq.', requires: ['get_event'] },
  ],
  children: [list, get, getTranscriptPage, getEvents],
});
