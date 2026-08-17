// The coordinator's function catalog: talking to the user, the
// agent spawn functions derived from the dynamic catalog plus cancel_thread,
// and — from stage 4 — the tool servers' functions (including the builtin
// 'storage'/'events' pull-tool servers). Definitions are part of the prompt-cache head: static with
// respect to RUN state (spawns do not change them; a catalog (re)load or a
// tool server (dis)connecting does, which legitimately resets the head).
// Synchronous calls are journaled as tool.call.* events in the coordinator's
// thread; spawns and cancels are async dispatches acknowledged with
// 'accepted' — their consequences arrive as events.

import type { ContentBlock, JsonObject } from '../core/contract.ts';
import { TELEGRAM_MARKDOWN_NOTE, THREAD_NAMING_NOTE } from '../../agents/world/index.ts';
import {
  CANCEL_REASON_PARAM_DESCRIPTION,
  CANCEL_THREAD_DESCRIPTION,
  SEND_TO_THREAD_DESCRIPTION,
} from '../capabilities/thread-verbs.ts';
import { appendEvent } from '../core/append.ts';
import { THREAD_CANCEL, THREAD_MESSAGE } from '../core/envelope.ts';
import { startThread } from '../core/threads.ts';
import { getUserFile } from '../files/index.ts';
import { getAgent, getAgents } from '../capabilities/agent-catalog.ts';
import { RESTART_SERVER_NAME } from '../capabilities/restart-tools.ts';
import { callToolJournaled } from '../capabilities/tool-journal.ts';
import {
  callServerTool,
  getServerToolFunctions,
  isServerToolFunction,
  type ToolBundle,
} from '../capabilities/tool-manager.ts';
import type { DispatchResult, FunctionCall, FunctionDefinition } from '../harness/openai/turn.ts';

// The coordinator's tool passport, listed explicitly like every agent's: the
// coordinator has no native file tools, so the workspace_files hands ride
// along; restart is the deliberately granted dangerous capability. A new
// tool server reaches the coordinator only by being added here.
const COORDINATOR_BUNDLE: ToolBundle = {
  declared: [
    'current_datetime',
    'events',
    'gmail',
    'http_get',
    'notion',
    'perplexity',
    'projects',
    'schedule',
    'storage',
    'storage_download_file',
    'workspace',
    'workspace_files',
    RESTART_SERVER_NAME,
  ],
};

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
          description: `The complete text to send. ${TELEGRAM_MARKDOWN_NOTE}`,
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
    name: 'send_to_thread',
    description:
      `${SEND_TO_THREAD_DESCRIPTION} For a headless agent (one without a forum topic) this is the only ` +
      'channel; for agents with a topic the user talks there directly — use this only when relaying is ' +
      'genuinely needed.',
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        threadId: {
          type: 'string',
          description: 'The child thread to message, as shown in thread.started or the active-threads status.',
        },
        text: {
          type: 'string',
          description: 'The message text delivered to the child agent.',
        },
      },
      required: ['threadId', 'text'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'cancel_thread',
    description: CANCEL_THREAD_DESCRIPTION,
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
          description: CANCEL_REASON_PARAM_DESCRIPTION,
        },
      },
      required: ['threadId', 'reason'],
      additionalProperties: false,
    },
  },
];

// The builtin pull tools ('storage', 'events') arrive through the server
// bundle like every other tool server — no separate definition path.
const RESERVED_FUNCTION_NAMES = new Set(STATIC_FUNCTION_DEFINITIONS.map(definition => definition.name));

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
          'Short human-readable title for the new thread, in the user’s language — it becomes the forum ' +
          `topic name. ${THREAD_NAMING_NOTE}`,
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

// The tool servers' functions for this user, connecting pending servers
// first. Non-strict: external MCP schemas are not guaranteed to satisfy the
// strict subset — the server validates input, errors feed back into the
// inner loop. A name taken by a static/builtin function or a catalog agent
// wins over a server tool (dispatch checks in that order).
async function getServerFunctionDefinitions(userId: string): Promise<FunctionDefinition[]> {
  const agentNames = new Set(getAgents().map(agent => agent.name));
  const definitions: FunctionDefinition[] = [];

  for (const fn of await getServerToolFunctions(userId, COORDINATOR_BUNDLE)) {
    if (RESERVED_FUNCTION_NAMES.has(fn.functionName) || agentNames.has(fn.functionName)) {
      console.warn(`[coordinator] server tool "${fn.functionName}" is shadowed and not exposed`);
      continue;
    }

    definitions.push({
      type: 'function',
      name: fn.functionName,
      description: fn.description,
      strict: false,
      parameters: fn.inputSchema,
    });
  }

  return definitions;
}

export async function getCoordinatorFunctionDefinitions(userId: string): Promise<FunctionDefinition[]> {
  return [
    ...STATIC_FUNCTION_DEFINITIONS,
    ...getAgentFunctionDefinitions(),
    ...(await getServerFunctionDefinitions(userId)),
  ];
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
// coordinator's thread; the router starts the run. Async by design —
// the model sees the thread in its transcript and status tail.
async function executeSpawn(agentName: string, args: JsonObject, ctx: DispatchContext): Promise<void> {
  const { thread_title: threadTitle, ...input } = args;
  const title = typeof threadTitle === 'string' && threadTitle.trim() ? threadTitle.trim() : agentName;
  const declaration = getAgent(agentName);

  await startThread({
    userId: ctx.userId,
    parentThreadId: ctx.threadId,
    agent: agentName,
    title,
    input,
    icon: declaration?.icon,
    headless: declaration?.headless,
    actor: 'agent',
    agentName: 'coordinator',
  });
}

async function executeSendToThread(args: JsonObject, ctx: DispatchContext): Promise<void> {
  const threadId = typeof args.threadId === 'string' ? args.threadId.trim() : '';
  const text = typeof args.text === 'string' ? args.text.trim() : '';

  if (!threadId || !text) {
    throw new Error('send_to_thread requires threadId and non-empty text');
  }

  // One-hop is validated by append: only a direct child can be addressed. A
  // child that terminated in between redirects back to the main thread, so
  // the fact is journaled rather than lost.
  await appendEvent({
    type: THREAD_MESSAGE,
    actor: 'agent',
    agentName: 'coordinator',
    userId: ctx.userId,
    threadId: ctx.threadId,
    targetThreadId: threadId,
    payload: { text },
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

  if (call.name === 'send_to_thread') {
    try {
      await executeSendToThread(args, ctx);

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

  // An agent name wins over a same-named server tool — mirroring the
  // definitions, where the shadowed server tool is not exposed.
  if (!getAgent(call.name) && isServerToolFunction(ctx.userId, COORDINATOR_BUNDLE, call.name)) {
    try {
      const outcome = await callToolJournaled(
        { userId: ctx.userId, threadId: ctx.threadId, agentName: 'coordinator' },
        call.callId,
        call.name,
        args,
        () => callServerTool({ userId: ctx.userId, threadId: ctx.threadId }, COORDINATOR_BUNDLE, call.name, args),
      );

      return { kind: 'sync', result: outcome.result };
    } catch (error) {
      return { kind: 'rejected', error: getErrorMessage(error) };
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
