// Builtin pull tools (§5.2): deep read access without a rights model, scoped
// to the workspace — list_threads (list + summaries), get_thread (transcript),
// get_event (one event in full), get_file (contents into model context).
// Layered reading mirrors the summarization: summaries first, the full
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
      'List the workspace threads: agent, title, status and the summary each completed thread left. Start here when past or parallel work matters; get_thread reads a full transcript.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: ['string', 'null'],
          enum: ['active', 'completed', 'failed', 'cancelled', null],
          description: 'Only threads with this status, or null for all.',
        },
      },
      required: ['status'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_thread',
    description:
      'Read one thread of this workspace: its metadata and transcript (the events it authored plus the events addressed to it). Long transcripts return the newest part; use get_event for anything truncated.',
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

function threadToJson(thread: Thread): JsonObject {
  return {
    threadId: thread.id,
    parentThreadId: thread.parentId,
    agent: thread.agent,
    title: thread.title,
    status: thread.status,
    summary: (thread.summary as JsonObject | null) ?? null,
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

async function executeListThreads(args: JsonObject, ctx: BuiltinToolContext): Promise<ToolResult> {
  const status = typeof args.status === 'string' ? args.status : undefined;

  if (status !== undefined && !['active', 'completed', 'failed', 'cancelled'].includes(status)) {
    throw new Error(`list_threads: unknown status "${status}"`);
  }

  const threads = await listThreads(ctx.userId, {
    ...(status !== undefined ? { status: status as Thread['status'] } : {}),
  });

  return { content: [], structuredContent: { threads: threads.map(threadToJson) } };
}

async function executeGetThread(args: JsonObject, ctx: BuiltinToolContext): Promise<ToolResult> {
  const threadId = typeof args.threadId === 'string' ? args.threadId.trim() : '';

  if (!threadId) {
    throw new Error('get_thread requires threadId');
  }

  const thread = await getThread(threadId);

  // Same error as a missing thread: existence outside the workspace is not
  // leaked.
  if (!thread || thread.userId !== ctx.userId) {
    throw new Error(`Thread "${threadId}" not found in this workspace`);
  }

  const events = await getTranscript(threadId, { last: GET_THREAD_HISTORY_LIMIT });
  const transcript = buildTranscript(events);

  return {
    content: transcript.text ? [{ type: 'text', text: transcript.text }] : [],
    structuredContent: {
      thread: threadToJson(thread),
      transcriptTruncated: transcript.dropped || events.length >= GET_THREAD_HISTORY_LIMIT,
    },
  };
}

const executors: Record<string, (args: JsonObject, ctx: BuiltinToolContext) => Promise<ToolResult>> = {
  get_event: executeGetEvent,
  get_file: executeGetFile,
  list_threads: executeListThreads,
  get_thread: executeGetThread,
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
