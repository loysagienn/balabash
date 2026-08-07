// The coordinator's function catalog (§7.3, §8.1): talking to the user, the
// builtin pull tools (§5.2), and — from stage 3 — the agent spawn functions
// derived from the dynamic catalog plus cancel_thread. Definitions are part
// of the prompt-cache head: static with respect to RUN state (spawns do not
// change them; only a catalog (re)load does, which legitimately resets the
// head). Synchronous calls are journaled as tool.call.* events in the
// coordinator's thread; spawns and cancels are async dispatches acknowledged
// with 'accepted' — their consequences arrive as events (§8.1).

import type { ContentBlock, JsonObject } from '../core/contract.ts';
import { appendEvent } from '../core/append.ts';
import { THREAD_CANCEL } from '../core/envelope.ts';
import { startThread } from '../core/threads.ts';
import { getUserFile } from '../files/index.ts';
import { getAgent, getAgents } from '../capabilities/agent-catalog.ts';
import { BUILTIN_TOOL_DEFINITIONS, callBuiltinTool, isBuiltinTool } from '../capabilities/builtin-tools.ts';
import type { DispatchResult, FunctionCall, FunctionDefinition } from '../harness/openai/turn.ts';

const STATIC_FUNCTION_DEFINITIONS: FunctionDefinition[] = [
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
    name: 'cancel_thread',
    description:
      'Cancel an active child thread — e.g. work the user asked to stop, or a run stuck without progress. The thread is closed as cancelled; its agent stops.',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        threadId: {
          type: 'string',
          description: 'The child thread to cancel, as shown in thread.started or the active-threads status.',
        },
        reason: {
          type: ['string', 'null'],
          description: 'A concise reason, or null when there is none.',
        },
      },
      required: ['threadId', 'reason'],
      additionalProperties: false,
    },
  },
];

// Builtin pull tools become strict function definitions as-is.
const BUILTIN_FUNCTION_DEFINITIONS: FunctionDefinition[] = BUILTIN_TOOL_DEFINITIONS.map(tool => ({
  type: 'function',
  name: tool.name,
  description: tool.description,
  strict: true,
  parameters: tool.inputSchema as Record<string, unknown>,
}));

const RESERVED_FUNCTION_NAMES = new Set(
  [...STATIC_FUNCTION_DEFINITIONS, ...BUILTIN_FUNCTION_DEFINITIONS].map(definition => definition.name),
);

function isObjectValue(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// The spawn function of an agent = the agent's input schema plus the
// injected thread_title (v1's addRunIdToSchema pattern): the surface shows
// the title as the forum topic name, so the model names every thread it
// starts.
function addThreadTitleToSchema(parameters: Record<string, unknown>): Record<string, unknown> {
  const properties = isObjectValue(parameters.properties) ? parameters.properties : {};
  const required = Array.isArray(parameters.required)
    ? parameters.required.filter(value => typeof value === 'string')
    : [];

  return {
    ...parameters,
    type: 'object',
    properties: {
      ...properties,
      thread_title: {
        type: 'string',
        description:
          'Short human-readable title for the new thread, in the user’s language — it becomes the forum topic name.',
      },
    },
    required: [...new Set([...required, 'thread_title'])],
  };
}

// Agents are sorted by name in the catalog, so the serialized bytes — and
// with them the prompt-cache head — do not depend on load order.
function getAgentFunctionDefinitions(): FunctionDefinition[] {
  const definitions: FunctionDefinition[] = [];

  for (const agent of getAgents()) {
    if (RESERVED_FUNCTION_NAMES.has(agent.name)) {
      console.warn(`[coordinator] agent "${agent.name}" is shadowed by a builtin function and not exposed`);
      continue;
    }

    definitions.push({
      type: 'function',
      name: agent.name,
      description: agent.description,
      strict: true,
      parameters: addThreadTitleToSchema(agent.parameters as Record<string, unknown>),
    });
  }

  return definitions;
}

export function getCoordinatorFunctionDefinitions(): FunctionDefinition[] {
  return [...STATIC_FUNCTION_DEFINITIONS, ...BUILTIN_FUNCTION_DEFINITIONS, ...getAgentFunctionDefinitions()];
}

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
    // Validation up front — scoped to the workspace: a dead or foreign
    // fileId must reject the call, not surface later as a failed delivery.
    const file = await getUserFile(ctx.userId, fileId);

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
    payload: { content },
  });
}

// Spawn a child thread for a catalog agent: thread.started addressed to the
// coordinator's thread; the router starts the run. Async by design (§8.1) —
// the model sees the thread in its transcript and status tail.
async function executeSpawn(agentName: string, args: JsonObject, ctx: DispatchContext): Promise<void> {
  const { thread_title: threadTitle, ...input } = args;
  const title = typeof threadTitle === 'string' && threadTitle.trim() ? threadTitle.trim() : agentName;
  const icon = getAgent(agentName)?.icon;

  await startThread({
    userId: ctx.userId,
    parentThreadId: ctx.threadId,
    agent: agentName,
    title,
    input,
    icon,
    actor: 'agent',
    agentName: 'coordinator',
  });
}

async function executeCancelThread(args: JsonObject, ctx: DispatchContext): Promise<void> {
  const threadId = typeof args.threadId === 'string' ? args.threadId.trim() : '';

  if (!threadId) {
    throw new Error('cancel_thread requires threadId');
  }

  const reason = typeof args.reason === 'string' && args.reason.trim() ? args.reason.trim() : 'cancelled';

  // One-hop and liveness are validated by append: a foreign or non-child
  // thread rejects the call, an already-terminated child is a no-op.
  await appendEvent({
    type: THREAD_CANCEL,
    actor: 'agent',
    agentName: 'coordinator',
    userId: ctx.userId,
    threadId: ctx.threadId,
    targetThreadId: threadId,
    payload: { reason },
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

  if (call.name === 'do_nothing') {
    return { kind: 'async' };
  }

  if (call.name === 'send_message') {
    try {
      await executeSendMessage(args, ctx);

      return { kind: 'async' };
    } catch (error) {
      return { kind: 'rejected', error: getErrorMessage(error) };
    }
  }

  if (call.name === 'cancel_thread') {
    try {
      await executeCancelThread(args, ctx);

      return { kind: 'async' };
    } catch (error) {
      return { kind: 'rejected', error: getErrorMessage(error) };
    }
  }

  if (isBuiltinTool(call.name)) {
    await journal('tool.call.started', { callId: call.callId, functionName: call.name, input: args });

    try {
      const result = await callBuiltinTool(call.name, args, { userId: ctx.userId });

      await journal('tool.call.completed', {
        callId: call.callId,
        functionName: call.name,
        result: result as unknown as JsonObject,
      });

      return { kind: 'sync', result };
    } catch (error) {
      const message = getErrorMessage(error);

      await journal('tool.call.failed', { callId: call.callId, functionName: call.name, error: message });

      return { kind: 'rejected', error: message };
    }
  }

  if (getAgent(call.name)) {
    try {
      await executeSpawn(call.name, args, ctx);

      return { kind: 'async' };
    } catch (error) {
      return { kind: 'rejected', error: getErrorMessage(error) };
    }
  }

  return { kind: 'rejected', error: `Unknown function "${call.name}"` };
}
