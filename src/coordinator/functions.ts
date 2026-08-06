// The coordinator's function catalog for stage 2: talking to the user and
// the two pull builtins (§5.2). Definitions are part of the prompt-cache
// head — static with respect to run state. Every synchronous call is
// journaled as tool.call.* events in the coordinator's thread (§4.2); the
// canonical result {content, structuredContent?} goes to the log as-is, the
// provider conversion happens in the harness.

import type { ContentBlock, Event, JsonObject, JsonValue, ToolResult } from '../core/contract.ts';
import { appendEvent } from '../core/append.ts';
import { getUserEvent } from '../core/events.ts';
import { getFile } from '../files/index.ts';
import type { DispatchResult, FunctionCall, FunctionDefinition } from '../harness/openai/turn.ts';

export const COORDINATOR_FUNCTION_DEFINITIONS: FunctionDefinition[] = [
  {
    type: 'function',
    name: 'send_message',
    description: 'Send a message to the user in this thread. Reply in the language used by the user.',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description:
            'The complete text to send. Use the supported Markdown subset: **bold**, *italic*, ~~strikethrough~~, `inline code`, fenced code blocks, [links](https://example.com), blockquotes, headings, and simple lists. Do not use HTML, tables, Markdown images, task lists, or deeply nested structures.',
        },
        fileIds: {
          type: ['array', 'null'],
          items: { type: 'string' },
          description: 'Stored file IDs to attach as documents, or null when sending text only.',
        },
      },
      required: ['text', 'fileIds'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'do_nothing',
    description:
      'Take no further action for the current events. Use this when no message or other side effect is needed.',
    strict: true,
    parameters: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'get_event',
    description:
      'Load one event from the workspace log in full by its seq. Use it to recover content the transcript view truncated or omitted.',
    strict: true,
    parameters: {
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
    type: 'function',
    name: 'get_file',
    description:
      'Load a stored file into model context. Call only when the file contents are needed; the transcript already contains its fileId and metadata.',
    strict: true,
    parameters: {
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

type DispatchContext = {
  userId: string;
  threadId: string;
};

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseArguments(rawArguments: string): JsonObject {
  const parsed = JSON.parse(rawArguments) as unknown;

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Function arguments must be a JSON object');
  }

  return parsed as JsonObject;
}

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

async function executeGetEvent(args: JsonObject, ctx: DispatchContext): Promise<ToolResult> {
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

async function executeGetFile(args: JsonObject): Promise<ToolResult> {
  const fileId = typeof args.fileId === 'string' ? args.fileId.trim() : '';

  if (!fileId) {
    throw new Error('get_file requires fileId');
  }

  const file = await getFile(fileId);
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

async function executeSendMessage(args: JsonObject, ctx: DispatchContext): Promise<void> {
  const text = typeof args.text === 'string' ? args.text : '';
  const fileIds = Array.isArray(args.fileIds)
    ? args.fileIds.filter((id): id is string => typeof id === 'string' && Boolean(id.trim()))
    : [];

  if (!text.trim() && !fileIds.length) {
    throw new Error('send_message requires non-empty text or fileIds');
  }

  const content: ContentBlock[] = [];

  if (text.trim()) {
    content.push({ type: 'text', text });
  }

  for (const fileId of fileIds) {
    // Validation up front: a dead fileId must reject the call, not surface
    // later as a failed delivery.
    const file = await getFile(fileId);

    content.push(
      file.contentType?.toLowerCase().startsWith('image/') ? { type: 'image', fileId } : { type: 'file', fileId },
    );
  }

  await appendEvent({
    type: 'agent.message',
    actor: 'agent',
    agentName: 'coordinator',
    userId: ctx.userId,
    threadId: ctx.threadId,
    payload: { content: content as unknown as JsonValue },
  });
}

// Dispatches one function call from the model, journaling synchronous tool
// calls as tool.call.* in the coordinator's thread.
export async function dispatchCoordinatorFunction(call: FunctionCall, ctx: DispatchContext): Promise<DispatchResult> {
  const journal = async (type: string, payload: JsonObject) => {
    await appendEvent({
      type,
      actor: 'agent',
      agentName: 'coordinator',
      userId: ctx.userId,
      threadId: ctx.threadId,
      payload,
    });
  };

  let args: JsonObject;

  try {
    args = parseArguments(call.arguments);
  } catch (error) {
    return { kind: 'rejected', error: `Invalid arguments: ${getErrorMessage(error)}` };
  }

  switch (call.name) {
    case 'do_nothing':
      return { kind: 'async' };

    case 'send_message':
      try {
        await executeSendMessage(args, ctx);

        return { kind: 'async' };
      } catch (error) {
        return { kind: 'rejected', error: getErrorMessage(error) };
      }

    case 'get_event':
    case 'get_file': {
      await journal('tool.call.started', { callId: call.callId, functionName: call.name, input: args });

      try {
        const result = call.name === 'get_event' ? await executeGetEvent(args, ctx) : await executeGetFile(args);

        await journal('tool.call.completed', {
          callId: call.callId,
          functionName: call.name,
          result: result as unknown as JsonValue as JsonObject,
        });

        return { kind: 'sync', result };
      } catch (error) {
        const message = getErrorMessage(error);

        await journal('tool.call.failed', { callId: call.callId, functionName: call.name, error: message });

        return { kind: 'rejected', error: message };
      }
    }

    default:
      return { kind: 'rejected', error: `Unknown function "${call.name}"` };
  }
}
