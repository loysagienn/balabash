// The coordinator's function catalog: talking to the user, the
// agent spawn functions derived from the dynamic catalog plus cancel_thread,
// and — from stage 4 — the tool servers' functions (including the builtin
// 'storage'/'events' pull-tool servers). Definitions are part of the prompt-cache head: static with
// respect to RUN state (spawns do not change them; a catalog (re)load or a
// tool server (dis)connecting does, which legitimately resets the head).
// Synchronous calls are journaled as tool.call.* events in the coordinator's
// thread; spawns and cancels are async dispatches acknowledged with
// 'accepted' — their consequences arrive as events. do_nothing ends the
// turn on the backends whose turn contract has no other end (the Responses
// API drivers run with forced tool calls); the Anthropic driver's turn ends
// when the model stops calling tools, and the function is not offered there.

import type { ContentBlock, JsonObject, JsonSchema, RemoteAgentDeclaration } from '../core/contract.ts';
import { THREAD_NAMING_NOTE } from '../../agents/world/index.ts';
import {
  CANCEL_REASON_PARAM_DESCRIPTION,
  CANCEL_THREAD_DESCRIPTION,
  FINISH_THREAD_DESCRIPTION,
  SEND_TO_THREAD_DESCRIPTION,
} from '../capabilities/thread-verbs.ts';
import { appendEvent } from '../core/append.ts';
import { THREAD_CANCEL, THREAD_FINISH, THREAD_MESSAGE } from '../core/envelope.ts';
import { startThread } from '../core/threads.ts';
import { resolveSpawnProject } from '../projects/store.ts';
import { getWorkspaceFile } from '../files/index.ts';
import { messageFile } from '../core/file-blocks.ts';
import { getAgent, getAgents, isRemoteAgent } from '../capabilities/agent-catalog.ts';
import { RESTART_SERVER_NAME } from '../capabilities/restart-tools.ts';
import { callToolJournaled } from '../capabilities/tool-journal.ts';
import {
  callServerTool,
  getServerToolFunctions,
  isServerToolFunction,
  type ToolBundle,
} from '../capabilities/tool-manager.ts';
import type { DispatchResult, FunctionCall, FunctionDefinition } from '../harness/turn-contract.ts';
import { getLlmBackend } from '../harness/openai/backend.ts';

// The coordinator's tool passport, listed explicitly like every agent's: the
// coordinator has no native file tools, so the workspace_files hands ride
// along; restart is the deliberately granted dangerous capability. A new
// repository tool server reaches the coordinator only by being added here;
// the installation's extension servers come with "projects" (the bundle
// rule of src/capabilities/tool-manager.ts). Exported
// for the console's agent catalog, which shows the secretary beside the
// catalog agents with the same passport (src/api/snapshot.ts).
export const COORDINATOR_BUNDLE: ToolBundle = {
  declared: [
    'apps',
    'current_datetime',
    'events',
    'gmail',
    'http_get',
    // Notion is deliberately absent: its tool catalog is the heaviest head
    // item by far and the secretary never used it — Notion work goes to the
    // agents that carry the server (manager, engineer, ...).
    'perplexity',
    'projects',
    'remote',
    'schedule',
    'storage',
    'storage_download_file',
    'workspace',
    'workspace_files',
    RESTART_SERVER_NAME,
  ],
};

// Who the coordinator is, for the console's agent catalog — the one place it
// is described to the operator (the agents describe themselves in their
// declarations; the coordinator's instructions speak to the model).
export const COORDINATOR_DESCRIPTION =
  'The secretary of the workspace: owns the main thread, talks with the user there, hands work out to the ' +
  'agents in child threads and relays what they bring back.';

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
          description: 'The complete text to send, in standard Markdown.',
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
      'End your turn: nothing more to do for the newest events. Call it as the last call, once every other ' +
      'call of this turn has returned — or right away when the newest events need no action at all.',
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
      `${SEND_TO_THREAD_DESCRIPTION} For a headless agent (one without a user-facing thread) this is the only ` +
      'channel; for user-facing agents the user talks in their thread directly — use this only when relaying is ' +
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
        fileIds: {
          type: ['array', 'null'],
          items: { type: 'string' },
          description: 'Stored file IDs to hand to the child with the message (it reads them by fileId), or null.',
        },
      },
      required: ['threadId', 'text', 'fileIds'],
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
  {
    type: 'function',
    name: 'finish_thread',
    description: `${FINISH_THREAD_DESCRIPTION} The summary arrives as the child's thread.completed.`,
    strict: true,
    parameters: {
      type: 'object',
      properties: {
        threadId: {
          type: 'string',
          description: 'The child thread to finish, as shown in thread.started or the active-threads status.',
        },
      },
      required: ['threadId'],
      additionalProperties: false,
    },
  },
];

// The builtin pull tools ('storage', 'events') arrive through the server
// bundle like every other tool server — no separate definition path.
const RESERVED_FUNCTION_NAMES = new Set(STATIC_FUNCTION_DEFINITIONS.map(definition => definition.name));

// The spawn function of an agent: every agent takes the same input — one
// text prompt — plus the thread_title (every user surface shows the title,
// so the model names every thread it starts).
const AGENT_SPAWN_PARAMETERS = {
  type: 'object',
  properties: {
    prompt: {
      type: 'string',
      description:
        'The task for the agent, with everything it should start from: the ask as the user framed it, ' +
        'known context, constraints and decisions, plus references (thread ids, event seqs) each with a ' +
        'one-line note. Files go in fileIds, not as ids in the text.',
    },
    fileIds: {
      type: ['array', 'null'],
      items: { type: 'string' },
      description:
        'Stored fileIds to attach to the task (e.g. the files the user sent), or null. The agent gets them ' +
        'as attachments of its first message.',
    },
    thread_title: {
      type: 'string',
      description:
        'Short human-readable title for the new thread, in the user’s language — it is what the user sees ' +
        `the thread as. ${THREAD_NAMING_NOTE}`,
    },
    project: {
      type: ['string', 'null'],
      description:
        'The slug of the project the work concerns (from your status block or projects_list), or null when ' +
        'it concerns none. Links the new thread to the project — name it whenever the task is about a project.',
    },
  },
  required: ['prompt', 'fileIds', 'thread_title', 'project'],
  additionalProperties: false,
} satisfies Record<string, unknown>;

// A JSON Schema as the strict function format wants it: every property
// required and nullable, no additional properties, recursively — the
// model passes null for what it leaves out, and the spawn drops the nulls
// (compactOptions). An enum admits null too; defaults are words of the
// description, not of the schema.
export function strictNullableSchema(schema: JsonSchema): JsonSchema {
  const out: Record<string, unknown> = { ...schema };
  const type = out.type;
  const types = Array.isArray(type) ? (type as unknown[]) : type === undefined ? [] : [type];

  if (types.length && !types.includes('null')) {
    out.type = [...types, 'null'];
  }

  if (Array.isArray(out.enum) && !out.enum.includes(null)) {
    out.enum = [...out.enum, null];
  }

  if (types.includes('object') || (out.properties && typeof out.properties === 'object')) {
    const properties = Object.fromEntries(
      Object.entries((out.properties ?? {}) as Record<string, JsonSchema>).map(([key, property]) => [key, strictNullableSchema(property)]),
    );

    out.properties = properties;
    out.required = Object.keys(properties);
    out.additionalProperties = false;
  }

  if (out.items && typeof out.items === 'object' && !Array.isArray(out.items)) {
    out.items = strictNullableSchema(out.items as JsonSchema);
  }

  if (out.default !== undefined) {
    out.description = `${typeof out.description === 'string' ? `${out.description} ` : ''}Default: ${JSON.stringify(out.default)}.`;
    delete out.default;
  }

  return out;
}

// The launch options the model named: nulls dropped, recursively; an
// object left empty is dropped too.
export function compactOptions(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const out: JsonObject = {};

  for (const [key, item] of Object.entries(value)) {
    if (item === null || item === undefined) {
      continue;
    }

    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const nested = compactOptions(item);

      if (Object.keys(nested).length) {
        out[key] = nested;
      }

      continue;
    }

    out[key] = item as JsonObject[string];
  }

  return out;
}

// The spawn function of a remote kind (RemoteAgentDeclaration): the prompt
// OR the session to adopt, the title and the project like every agent's,
// plus the options by the kind's own schema — the one exception to "every
// agent takes one prompt", for the kinds of extensions only.
export function remoteSpawnParameters(kind: Pick<RemoteAgentDeclaration, 'options'>): Record<string, unknown> {
  const options = strictNullableSchema(kind.options ?? { type: 'object', properties: {} });

  return {
    type: 'object',
    properties: {
      prompt: {
        type: ['string', 'null'],
        description:
          'The task for the remote agent, with everything it should start from (the ask, known context, ' +
          'constraints, references). Null when adopting an existing session.',
      },
      adopt: {
        type: ['string', 'null'],
        description: 'The id or link of an existing session of this system to adopt as the thread, or null to start a new one. Exactly one of prompt and adopt.',
      },
      fileIds: {
        ...AGENT_SPAWN_PARAMETERS.properties.fileIds,
        description:
          'Stored fileIds to attach to the task, or null. The remote agent receives the files themselves in ' +
          'its session — it has no access to Balabash storage, so a fileId in the text is useless to it. ' +
          'Null when adopting (send files to the thread once it is open).',
      },
      thread_title: AGENT_SPAWN_PARAMETERS.properties.thread_title,
      project: AGENT_SPAWN_PARAMETERS.properties.project,
      options: {
        ...options,
        type: ['object', 'null'],
        description: 'The launch parameters of the external system (each null for its default), or null for all defaults.',
      },
    },
    required: ['prompt', 'adopt', 'fileIds', 'thread_title', 'project', 'options'],
    additionalProperties: false,
  };
}

const REMOTE_SPAWN_NOTE =
  ' The thread mirrors a session in an external system and talks to the user directly; you only start ' +
  'it and get its summary when it ends (finish_thread asks the session for one; the session itself is ' +
  'endless and the thread merely pauses when idle). ';

// Agents are sorted by name in the catalog, so the serialized bytes — and
// with them the prompt-cache head — do not depend on load order.
function getAgentFunctionDefinitions(): FunctionDefinition[] {
  const definitions: FunctionDefinition[] = [];

  for (const agent of getAgents()) {
    if (RESERVED_FUNCTION_NAMES.has(agent.name)) {
      console.warn(`[coordinator] agent "${agent.name}" is shadowed by a builtin function and not exposed`);
      continue;
    }

    if (isRemoteAgent(agent)) {
      definitions.push({
        type: 'function',
        name: agent.name,
        description: `${agent.description}${REMOTE_SPAWN_NOTE}${THREAD_NAMING_NOTE}`,
        strict: true,
        parameters: remoteSpawnParameters(agent),
      });
      continue;
    }

    definitions.push({
      type: 'function',
      name: agent.name,
      description: agent.description,
      strict: true,
      parameters: AGENT_SPAWN_PARAMETERS,
    });
  }

  return definitions;
}

// The tool servers' functions for this workspace, connecting pending servers
// first. Non-strict: external MCP schemas are not guaranteed to satisfy the
// strict subset — the server validates input, errors feed back into the
// inner loop. A name taken by a static/builtin function or a catalog agent
// wins over a server tool (dispatch checks in that order).
async function getServerFunctionDefinitions(workspaceId: string): Promise<FunctionDefinition[]> {
  const agentNames = new Set(getAgents().map(agent => agent.name));
  const definitions: FunctionDefinition[] = [];

  for (const fn of await getServerToolFunctions(workspaceId, COORDINATOR_BUNDLE)) {
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

export async function getCoordinatorFunctionDefinitions(workspaceId: string): Promise<FunctionDefinition[]> {
  const endsByCall = getLlmBackend().kind !== 'anthropic';

  return [
    ...STATIC_FUNCTION_DEFINITIONS.filter(definition => endsByCall || definition.name !== 'do_nothing'),
    ...getAgentFunctionDefinitions(),
    ...(await getServerFunctionDefinitions(workspaceId)),
  ];
}

type DispatchContext = {
  workspaceId: string;
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
    const file = await getWorkspaceFile(ctx.workspaceId, fileId);

    content.push(
      file.contentType?.toLowerCase().startsWith('image/') ? { type: 'image', fileId } : { type: 'file', fileId },
    );
  }

  await appendEvent({
    type: 'agent.message',
    actor: 'agent',
    agentName: 'coordinator',
    workspaceId: ctx.workspaceId,
    threadId: ctx.threadId,
    payload: { content },
  });
}

// A text answer of the model (the Anthropic driver: a text block is the
// model's message to the user) delivered the way send_message delivers —
// the same agent.message event, text only.
export async function deliverCoordinatorText(text: string, ctx: DispatchContext): Promise<void> {
  await executeSendMessage({ text, fileIds: null }, ctx);
}

// Spawn a child thread for a catalog agent: thread.started addressed to the
// coordinator's thread; the router starts the run. Async by design —
// the model sees the thread in its transcript and status tail.
async function executeSpawn(agentName: string, args: JsonObject, ctx: DispatchContext): Promise<void> {
  const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
  const threadTitle = args.thread_title;
  const title = typeof threadTitle === 'string' && threadTitle.trim() ? threadTitle.trim() : agentName;
  const declaration = getAgent(agentName);
  const projectSlug = typeof args.project === 'string' && args.project.trim() ? args.project.trim() : undefined;
  // The attachments of the task: validated up front against the workspace
  // like send_to_thread's — a dead or foreign fileId rejects the spawn.
  const files = await Promise.all(uniqueFileIds(args.fileIds).map(fileId => getWorkspaceFile(ctx.workspaceId, fileId)));

  // A remote kind: a new session from the prompt, or an existing one
  // adopted — exactly one. The secretary's remote thread talks to the user
  // (not headless): the owner is whoever spawned it (src/remote/engine.ts).
  if (declaration && isRemoteAgent(declaration)) {
    const adopt = typeof args.adopt === 'string' ? args.adopt.trim() : '';

    if (Boolean(prompt) === Boolean(adopt)) {
      throw new Error(`Spawning "${agentName}" takes exactly one of prompt (a new session) and adopt (an existing one)`);
    }

    if (adopt && files.length) {
      throw new Error(`Adopting a session of "${agentName}" takes no files: send them to the thread once it is open`);
    }

    await startThread({
      workspaceId: ctx.workspaceId,
      parentThreadId: ctx.threadId,
      agent: agentName,
      title,
      input: prompt || adopt,
      icon: declaration.icon,
      headless: false,
      remote: true,
      options: compactOptions(args.options),
      adopt: Boolean(adopt),
      ...(files.length ? { files } : {}),
      project: await resolveSpawnProject(ctx.workspaceId, projectSlug),
      actor: 'agent',
      agentName: 'coordinator',
    });

    return;
  }

  if (!prompt) {
    throw new Error(`Spawning "${agentName}" requires a non-empty prompt`);
  }

  await startThread({
    workspaceId: ctx.workspaceId,
    parentThreadId: ctx.threadId,
    agent: agentName,
    title,
    input: prompt,
    icon: declaration?.icon,
    headless: declaration?.headless,
    ...(files.length ? { files } : {}),
    project: await resolveSpawnProject(ctx.workspaceId, projectSlug),
    actor: 'agent',
    agentName: 'coordinator',
  });
}

// The fileIds of a call: strings, trimmed, deduplicated.
function uniqueFileIds(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === 'string' && Boolean(id.trim())).map(id => id.trim()))] : [];
}

async function executeSendToThread(args: JsonObject, ctx: DispatchContext): Promise<void> {
  const threadId = typeof args.threadId === 'string' ? args.threadId.trim() : '';
  const text = typeof args.text === 'string' ? args.text.trim() : '';
  const fileIds = uniqueFileIds(args.fileIds);

  if (!threadId || !text) {
    throw new Error('send_to_thread requires threadId and non-empty text');
  }

  // The files go as a thread.message carries them (the agent runtime's
  // sendToChild): validated up front against the workspace — a dead or
  // foreign fileId rejects the call — the references for the model, the
  // facts for the reader.
  const files = await Promise.all(fileIds.map(fileId => getWorkspaceFile(ctx.workspaceId, fileId)));

  // One-hop is validated by append: only a direct child can be addressed. A
  // child that terminated in between redirects back to the main thread, so
  // the fact is journaled rather than lost.
  await appendEvent({
    type: THREAD_MESSAGE,
    actor: 'agent',
    agentName: 'coordinator',
    workspaceId: ctx.workspaceId,
    threadId: ctx.threadId,
    targetThreadId: threadId,
    payload: { text, ...(files.length ? { fileIds: files.map(file => file.id), files: files.map(messageFile) } : {}) },
  });
}

async function executeFinishThread(args: JsonObject, ctx: DispatchContext): Promise<void> {
  const threadId = typeof args.threadId === 'string' ? args.threadId.trim() : '';

  if (!threadId) {
    throw new Error('finish_thread requires threadId');
  }

  // One-hop and liveness are validated by append. An agent's run turns the
  // command into the request to wrap up and end the thread itself; a remote
  // thread's engine asks the session for its closing summary.
  await appendEvent({
    type: THREAD_FINISH,
    actor: 'agent',
    agentName: 'coordinator',
    workspaceId: ctx.workspaceId,
    threadId: ctx.threadId,
    targetThreadId: threadId,
    payload: { reason: 'finished_by_coordinator' },
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
    workspaceId: ctx.workspaceId,
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
    return { kind: 'end' };
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

  if (call.name === 'finish_thread') {
    try {
      await executeFinishThread(args, ctx);

      return { kind: 'async' };
    } catch (error) {
      return { kind: 'rejected', error: getErrorMessage(error) };
    }
  }

  // An agent name wins over a same-named server tool — mirroring the
  // definitions, where the shadowed server tool is not exposed.
  if (!getAgent(call.name) && isServerToolFunction(ctx.workspaceId, COORDINATOR_BUNDLE, call.name)) {
    try {
      const outcome = await callToolJournaled(
        { workspaceId: ctx.workspaceId, threadId: ctx.threadId, agentName: 'coordinator' },
        call.callId,
        call.name,
        args,
        () => callServerTool({ workspaceId: ctx.workspaceId, threadId: ctx.threadId }, COORDINATOR_BUNDLE, call.name, args),
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
