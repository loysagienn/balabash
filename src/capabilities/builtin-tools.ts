// Builtin pull tools (§5.2): deep read access without a rights model, scoped
// to the workspace — list_threads (the list, no summaries), get_thread (one
// thread + summary), get_thread_events (the transcript), get_event (one event
// in full), get_file (contents into model context). Layered reading mirrors
// the summarization: the list first, a summary on request, the full
// transcript on demand. One implementation serves both the coordinator's
// function catalog and the ToolsApi handed to dynamic agents.

import type { Event, JsonObject, Thread, ToolDefinition, ToolResult } from '../core/contract.ts';
import { getTranscript, getUserEvent } from '../core/events.ts';
import { getThread, listThreads } from '../core/threads.ts';
import { getUserFile } from '../files/index.ts';
import { buildTranscript } from '../harness/openai/transcript.ts';

export const BUILTIN_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'get_event',
    description:
      'Load one event from the workspace log in full by its seq. Use it to recover content the transcript view truncated or omitted.',
    inputSchema: {
      type: 'object',
      properties: {
        seq: {
          type: 'integer',
          description: 'The seq of the event, as shown in the transcript.',
        },
      },
      required: ['seq'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_file',
    description:
      'Load a stored file into model context. Call only when the file contents are needed; the transcript already contains its fileId and metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        fileId: {
          type: 'string',
          description: 'The file ID from an event or tool result.',
        },
      },
      required: ['fileId'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_threads',
    description:
      'List the workspace threads: agent, title, status and timestamps (no summaries). Start here when past or ' +
      'parallel work matters; get_thread reads one thread with its summary, get_thread_events its full transcript.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: ['string', 'null'],
          enum: ['active', 'completed', 'failed', 'cancelled', null],
          description: 'Only threads with this status, or null for all.',
        },
        createdAtGte: {
          type: ['string', 'null'],
          description: 'Only threads started at or after this ISO 8601 time, or null.',
        },
        createdAtLte: {
          type: ['string', 'null'],
          description: 'Only threads started at or before this ISO 8601 time, or null.',
        },
        limit: {
          type: ['integer', 'null'],
          description: 'Return at most this many threads, keeping the newest matches (default 100).',
        },
      },
      required: ['status', 'createdAtGte', 'createdAtLte', 'limit'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_thread',
    description:
      'Read one thread of this workspace: the same fields as list_threads plus the summary the thread left. ' +
      'For the detailed course of the thread use get_thread_events.',
    inputSchema: {
      type: 'object',
      properties: {
        threadId: {
          type: 'string',
          description: 'The thread id, e.g. from list_threads or a thread.started event.',
        },
      },
      required: ['threadId'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_thread_events',
    description:
      'Read the transcript of one thread: the events it authored plus the events addressed to it, newest part ' +
      'for long threads. Heavy output — use only when the detailed course of the thread really matters; ' +
      'otherwise get_thread (metadata + summary) is enough. Use get_event for anything truncated.',
    inputSchema: {
      type: 'object',
      properties: {
        threadId: {
          type: 'string',
          description: 'The thread id, e.g. from list_threads or a thread.started event.',
        },
      },
      required: ['threadId'],
      additionalProperties: false,
    },
  },
];

// Raw transcript window for get_thread; the char budget of buildTranscript
// bounds the actual output.
const GET_THREAD_HISTORY_LIMIT = 400;

type BuiltinToolContext = {
  userId: string;
};

// The full event for the model: the envelope with seq as a number and dates
// as ISO strings, JSON-serializable.
function eventToJson(event: Event): JsonObject {
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

// The list view: everything but the summary — summaries grow with history
// and are read per thread via get_thread.
function threadToJson(thread: Thread): JsonObject {
  return {
    threadId: thread.id,
    parentThreadId: thread.parentId,
    agent: thread.agent,
    title: thread.title,
    status: thread.status,
    createdAt: thread.createdAt.toISOString(),
    updatedAt: thread.updatedAt.toISOString(),
  };
}

async function executeGetEvent(args: JsonObject, ctx: BuiltinToolContext): Promise<ToolResult> {
  const seq = typeof args.seq === 'number' && Number.isInteger(args.seq) ? BigInt(args.seq) : null;

  if (seq === null) {
    throw new Error('get_event requires an integer seq');
  }

  const event = await getUserEvent(ctx.userId, seq);

  if (!event) {
    throw new Error(`Event seq=${args.seq} not found in this workspace`);
  }

  return { content: [], structuredContent: eventToJson(event) };
}

async function executeGetFile(args: JsonObject, ctx: BuiltinToolContext): Promise<ToolResult> {
  const fileId = typeof args.fileId === 'string' ? args.fileId.trim() : '';

  if (!fileId) {
    throw new Error('get_file requires fileId');
  }

  // Scoped to the workspace: a model-supplied fileId must not reach across
  // the user boundary.
  const file = await getUserFile(ctx.userId, fileId);
  const isImage = Boolean(file.contentType?.toLowerCase().startsWith('image/'));

  // Metadata goes into structuredContent; the content itself is a canonical
  // block — the harness materializes the presigned URL when the model needs
  // the bytes (§9).
  return {
    content: [isImage ? { type: 'image', fileId } : { type: 'file', fileId }],
    structuredContent: {
      fileId: file.id,
      filename: file.originalFilename,
      contentType: file.contentType,
      sizeBytes: file.sizeBytes,
      width: file.width,
      height: file.height,
    },
  };
}

function parseDateArg(name: string, value: unknown): Date | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  const date = typeof value === 'string' ? new Date(value) : null;

  if (!date || Number.isNaN(date.getTime())) {
    throw new Error(`list_threads: ${name} must be an ISO 8601 date-time string`);
  }

  return date;
}

const LIST_THREADS_LIMIT_MAX = 1000;

async function executeListThreads(args: JsonObject, ctx: BuiltinToolContext): Promise<ToolResult> {
  const status = typeof args.status === 'string' ? args.status : undefined;

  if (status !== undefined && !['active', 'completed', 'failed', 'cancelled'].includes(status)) {
    throw new Error(`list_threads: unknown status "${status}"`);
  }

  const createdAtGte = parseDateArg('createdAtGte', args.createdAtGte);
  const createdAtLte = parseDateArg('createdAtLte', args.createdAtLte);

  let limit: number | undefined;

  if (args.limit !== null && args.limit !== undefined) {
    if (typeof args.limit !== 'number' || !Number.isInteger(args.limit) || args.limit < 1) {
      throw new Error('list_threads: limit must be a positive integer');
    }

    limit = Math.min(args.limit, LIST_THREADS_LIMIT_MAX);
  }

  const threads = await listThreads(ctx.userId, {
    ...(status !== undefined ? { status: status as Thread['status'] } : {}),
    ...(createdAtGte !== undefined ? { createdAtGte } : {}),
    ...(createdAtLte !== undefined ? { createdAtLte } : {}),
    ...(limit !== undefined ? { limit } : {}),
  });

  return { content: [], structuredContent: { threads: threads.map(threadToJson) } };
}

// Same error as a missing thread: existence outside the workspace is not
// leaked.
async function getWorkspaceThread(threadId: string, ctx: BuiltinToolContext): Promise<Thread> {
  const thread = threadId ? await getThread(threadId) : null;

  if (!thread || thread.userId !== ctx.userId) {
    throw new Error(`Thread "${threadId}" not found in this workspace`);
  }

  return thread;
}

async function executeGetThread(args: JsonObject, ctx: BuiltinToolContext): Promise<ToolResult> {
  const threadId = typeof args.threadId === 'string' ? args.threadId.trim() : '';
  const thread = await getWorkspaceThread(threadId, ctx);

  return {
    content: [],
    structuredContent: {
      thread: {
        ...threadToJson(thread),
        summary: (thread.summary as JsonObject | null) ?? null,
      },
    },
  };
}

// The transcript goes out as a plain text block, without structuredContent:
// per the MCP spec a structuredContent result is expected to mirror into
// content, so clients (the Claude Agent SDK among them) may show the model
// structuredContent alone — a split result would lose the transcript.
async function executeGetThreadEvents(args: JsonObject, ctx: BuiltinToolContext): Promise<ToolResult> {
  const threadId = typeof args.threadId === 'string' ? args.threadId.trim() : '';
  const thread = await getWorkspaceThread(threadId, ctx);

  const events = await getTranscript(thread.id, { last: GET_THREAD_HISTORY_LIMIT });
  const transcript = buildTranscript(events);
  const truncated = transcript.dropped || events.length >= GET_THREAD_HISTORY_LIMIT;

  const parts = [
    ...(truncated ? ['(transcript truncated: only the newest part is shown; use get_event(seq) for older events)'] : []),
    ...(transcript.text ? [transcript.text] : ['(no events)']),
  ];

  return { content: [{ type: 'text', text: parts.join('\n') }] };
}

const executors: Record<string, (args: JsonObject, ctx: BuiltinToolContext) => Promise<ToolResult>> = {
  get_event: executeGetEvent,
  get_file: executeGetFile,
  list_threads: executeListThreads,
  get_thread: executeGetThread,
  get_thread_events: executeGetThreadEvents,
};

export function isBuiltinTool(name: string): boolean {
  return name in executors;
}

export async function callBuiltinTool(name: string, args: JsonObject, ctx: BuiltinToolContext): Promise<ToolResult> {
  const executor = executors[name];

  if (!executor) {
    throw new Error(`Unknown builtin tool "${name}"`);
  }

  return executor(args, ctx);
}
