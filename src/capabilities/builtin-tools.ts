// Builtin pull tools (§5.2): deep read access without a rights model, scoped
// to the workspace. Two builtin tool servers behind the same server/bundle
// surface as everything else (§7.4): 'storage' — storage_get_file (a stored
// file's metadata plus a presigned URL); 'events' — list_threads (the list,
// no summaries), get_thread (one thread + summary), get_thread_events (the
// transcript), get_event (one event in full). Layered reading mirrors the
// summarization: the list first, a summary on request, the full transcript
// on demand. Neither server is consent-gated: 'all' bundles both; agents
// with an explicit tool list name them per server.

import type { Event, JsonObject, JsonValue, Thread, ToolDefinition } from '../core/contract.ts';
import { getTranscript, getUserEvent } from '../core/events.ts';
import { getThread, listThreads } from '../core/threads.ts';
import { getFileDownloadUrl, getUserFile } from '../files/index.ts';
import { buildTranscript } from '../harness/openai/transcript.ts';
import type { ToolFunction } from './mcp-client.ts';
import type { BuiltinToolServer } from './tool-manager.ts';

export const STORAGE_SERVER_NAME = 'storage';
export const EVENTS_SERVER_NAME = 'events';

const STORAGE_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'storage_get_file',
    description:
      'Read a file from Balabash file storage (the fileId-addressed store behind send_file, end_thread and ' +
      'message attachments): its metadata plus a presigned, time-limited download URL. Use the URL to share ' +
      'the file or to download it when the contents are needed; the transcript already contains the fileId ' +
      'and metadata. To process a stored file with workspace tools or scripts, prefer workspace_import_file ' +
      'where available.',
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
];

const EVENTS_TOOL_DEFINITIONS: ToolDefinition[] = [
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
    name: 'list_threads',
    description:
      'List the workspace threads: agent, title, short description and status (no summaries). A completed ' +
      'thread describes itself: the description (~300 chars) says what it worked on and how it ended — often ' +
      'enough to tell whether a thread is the one you need. Start here when past or parallel work matters; ' +
      'get_thread reads one thread with its summary, get_thread_events its full transcript.',
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
      'Read one thread of this workspace: the same fields as list_threads (title, description, status) plus ' +
      'the full summary the thread left. For the detailed course of the thread use get_thread_events.',
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
// and are read per thread via get_thread. The description (~300 chars, from
// the thread's own completion) is short enough to ride the list.
function threadToJson(thread: Thread): JsonObject {
  return {
    threadId: thread.id,
    parentThreadId: thread.parentId,
    agent: thread.agent,
    title: thread.title,
    description: thread.description,
    status: thread.status,
    createdAt: thread.createdAt.toISOString(),
    updatedAt: thread.updatedAt.toISOString(),
  };
}

async function executeGetEvent(args: JsonObject, ctx: BuiltinToolContext): Promise<JsonValue> {
  const seq = typeof args.seq === 'number' && Number.isInteger(args.seq) ? BigInt(args.seq) : null;

  if (seq === null) {
    throw new Error('get_event requires an integer seq');
  }

  const event = await getUserEvent(ctx.userId, seq);

  if (!event) {
    throw new Error(`Event seq=${args.seq} not found in this workspace`);
  }

  return eventToJson(event);
}

async function executeGetFile(args: JsonObject, ctx: BuiltinToolContext): Promise<JsonValue> {
  const fileId = typeof args.fileId === 'string' ? args.fileId.trim() : '';

  if (!fileId) {
    throw new Error('storage_get_file requires fileId');
  }

  // Scoped to the workspace: a model-supplied fileId must not reach across
  // the user boundary.
  const file = await getUserFile(ctx.userId, fileId);
  const { url } = await getFileDownloadUrl(fileId);

  // The one FileRef (§9) plus its ephemeral url. The OpenAI harness
  // recognizes the result by the tool name and feeds the URL to the model as
  // input_image/input_file; SDK sessions download the URL themselves when
  // the contents matter. The transcript renders this result without the url
  // — it expires.
  return { ...file, url };
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

async function executeListThreads(args: JsonObject, ctx: BuiltinToolContext): Promise<JsonValue> {
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

  return { threads: threads.map(threadToJson) };
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

async function executeGetThread(args: JsonObject, ctx: BuiltinToolContext): Promise<JsonValue> {
  const threadId = typeof args.threadId === 'string' ? args.threadId.trim() : '';
  const thread = await getWorkspaceThread(threadId, ctx);

  return {
    thread: {
      ...threadToJson(thread),
      summary: (thread.summary as JsonObject | null) ?? null,
    },
  };
}

// The transcript is one string; the birth wrapper ships it as
// {result: string}. structuredContent alone is enough: the model-side
// consumers read structuredContent first and ignore content (verified for
// the Claude SDK and codex).
async function executeGetThreadEvents(args: JsonObject, ctx: BuiltinToolContext): Promise<JsonValue> {
  const threadId = typeof args.threadId === 'string' ? args.threadId.trim() : '';
  const thread = await getWorkspaceThread(threadId, ctx);

  const events = await getTranscript(thread.id, { last: GET_THREAD_HISTORY_LIMIT });
  const transcript = buildTranscript(events);
  const truncated = transcript.dropped || events.length >= GET_THREAD_HISTORY_LIMIT;

  const parts = [
    ...(truncated ? ['(transcript truncated: only the newest part is shown; use get_event(seq) for older events)'] : []),
    ...(transcript.text ? [transcript.text] : ['(no events)']),
  ];

  return parts.join('\n');
}

// One builtin tool server: static ToolFunction list, executor dispatch. The
// birth contract (§9) lives at the call site — callServerTool wraps the call
// in runToolHandler; here an executor returns data or throws.
function createPullToolServer(
  serverName: string,
  definitions: ToolDefinition[],
  executors: Record<string, (args: JsonObject, ctx: BuiltinToolContext) => Promise<JsonValue>>,
): BuiltinToolServer {
  const functions: ToolFunction[] = definitions.map(tool => ({
    functionName: tool.name,
    serverName,
    toolName: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema as Record<string, unknown>,
  }));

  return {
    name: serverName,
    consent: false,
    functionNames: definitions.map(tool => tool.name),

    getFunctions: async () => functions,

    call: async (toolName, args, ctx) => {
      const executor = executors[toolName];

      // An unknown tool is breakage of the call itself, not a tool answer —
      // it stays a throw (journaled as tool.call.failed).
      if (!executor) {
        throw new Error(`Unknown ${serverName} tool "${toolName}"`);
      }

      return executor(args, { userId: ctx.userId });
    },
  };
}

export function createStorageToolServer(): BuiltinToolServer {
  return createPullToolServer(STORAGE_SERVER_NAME, STORAGE_TOOL_DEFINITIONS, {
    storage_get_file: executeGetFile,
  });
}

export function createEventsToolServer(): BuiltinToolServer {
  return createPullToolServer(EVENTS_SERVER_NAME, EVENTS_TOOL_DEFINITIONS, {
    get_event: executeGetEvent,
    list_threads: executeListThreads,
    get_thread: executeGetThread,
    get_thread_events: executeGetThreadEvents,
  });
}
