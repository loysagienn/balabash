// Dynamic agent runs (§7): builds the RunContext and turns an
// AgentDeclaration into a RoutedRun for the thread router. Core behaviour is
// injected through ctx (§7.1) — the agent module never imports runtime
// values from the bundle.

import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type {
  Event,
  FilesApi,
  JsonObject,
  NotificationLevel,
  RunContext,
  SpawnOptions,
  Thread,
  ToolResult,
  ToolsApi,
} from '../core/contract.ts';
import { appendEvent } from '../core/append.ts';
import {
  THREAD_CANCEL,
  THREAD_COMPLETED,
  THREAD_FAILED,
  THREAD_MESSAGE,
  THREAD_NOTIFICATION,
  THREAD_PROGRESS,
} from '../core/envelope.ts';
import { startThread } from '../core/threads.ts';
import { getUserFile, getFileDownloadUrl, ingestFile } from '../files/index.ts';
import type { StorageBody } from '../files/storage.ts';
import { createClaudeSession } from '../harness/claude-sdk/sdk-session.ts';
import { createCodexSession } from '../harness/codex-sdk/sdk-session.ts';
import type { RoutedRun } from '../runtime/router.ts';
import { Ajv, type ValidateFunction } from 'ajv';
import { getAgent } from './agent-catalog.ts';
import { createSessionRun } from './session-run.ts';
import { callToolJournaled } from './tool-journal.ts';
import { callServerTool, getServerToolFunctions, type ToolBundle } from './tool-manager.ts';
import { validateAgentRun } from './validate-agent.ts';

const AGENT_STATE_ROOT = path.resolve('data', 'agent-state');

// Central spawn-input validation (§7.1): the declaration's `parameters` is
// the single schema every spawn path answers to — the coordinator's strict
// function calls and ctx.spawn alike. Compiled validators are cached per
// agent; the catalog is static, so the cache never invalidates.
const ajv = new Ajv({ allErrors: true, strictSchema: false });
const inputValidators = new Map<string, ValidateFunction>();

function validateAgentInput(declarationName: string, parameters: object, input: unknown): JsonObject {
  let validate = inputValidators.get(declarationName);

  if (!validate) {
    validate = ajv.compile(parameters);
    inputValidators.set(declarationName, validate);
  }

  const candidate = input ?? {};

  if (!validate(candidate)) {
    const details = (validate.errors ?? [])
      .map(error => `${error.instancePath || '(root)'} ${error.message ?? 'is invalid'}`)
      .join('; ');

    throw new Error(`Invalid input for agent "${declarationName}": ${details || 'schema mismatch'}`);
  }

  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new Error(`Invalid input for agent "${declarationName}": input must be a JSON object`);
  }

  return candidate as JsonObject;
}

const NOTIFICATION_RANK: Record<NotificationLevel, number> = { silent: 0, normal: 1, urgent: 2 };

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// File references in an outgoing thread.message: deduplicated and checked
// against the workspace (a foreign or unknown fileId throws).
async function validateMessageFileIds(userId: string, fileIds: string[] | undefined): Promise<string[]> {
  const unique = [...new Set((fileIds ?? []).map(id => id.trim()).filter(Boolean))];

  await Promise.all(unique.map(fileId => getUserFile(userId, fileId)));

  return unique;
}

// An event's level must not exceed the thread's level (§11.3).
function clampNotificationLevel(requested: NotificationLevel, threadLevel: NotificationLevel): NotificationLevel {
  return NOTIFICATION_RANK[requested] > NOTIFICATION_RANK[threadLevel] ? threadLevel : requested;
}

// The run's ToolsApi (§7.4): the agent's bundle of tool servers (builtin
// servers like 'storage'/'events' included through the same bundle machinery).
// Every call goes through the one tool.call.* journaling point; the
// completed payload is the verbatim result (§9).
function createToolsApi({
  userId,
  threadId,
  agentName,
  bundle,
}: {
  userId: string;
  threadId: string;
  agentName: string;
  bundle: ToolBundle;
}): ToolsApi {
  return {
    list: async () =>
      (await getServerToolFunctions(userId, bundle)).map(fn => ({
        name: fn.functionName,
        description: fn.description,
        inputSchema: fn.inputSchema,
      })),

    call: async (name, args): Promise<ToolResult> => {
      const outcome = await callToolJournaled({ userId, threadId, agentName }, randomUUID(), name, args, () =>
        callServerTool({ userId, threadId }, bundle, name, args),
      );

      return outcome.result;
    },
  };
}

function createFilesApi(userId: string, agentName: string): FilesApi {
  return {
    // The one FileRef (§9): the files layer already returns it verbatim.
    getInfo: async fileId => getUserFile(userId, fileId),

    getDownloadUrl: async fileId => {
      // Scope check first: the presigned URL layer itself is workspace-blind.
      await getUserFile(userId, fileId);

      const { url } = await getFileDownloadUrl(fileId);

      return url;
    },

    // Workspace-scoped by construction: the stored file belongs to the run's
    // user, so it is deliverable through every user-scoped path (ctx.files,
    // storage_get_file, send_message fileIds).
    ingest: async input =>
      ingestFile({
        // The contract's NodeJS.ReadableStream is a stream.Readable at
        // runtime; the storage layer types are narrower than the interface.
        body: input.body as StorageBody,
        originalFilename: input.filename ?? null,
        contentType: input.contentType ?? null,
        sizeBytes: input.sizeBytes ?? null,
        scope: agentName,
        userId,
      }),
  };
}

// Spawns the run for a freshly started child thread (router hook). Returns
// null when the run cannot start; the failure is journaled as the thread's
// terminal, so the parent learns about it the ordinary way.
export async function spawnAgentRun(thread: Thread, startedEvent: Event): Promise<RoutedRun | null> {
  const failThread = async (error: string) => {
    await appendEvent({
      type: THREAD_FAILED,
      actor: 'system',
      userId: thread.userId,
      threadId: thread.id,
      payload: { error },
    }).catch(appendError => {
      console.error(`[agent-run:${thread.id}] failed to journal spawn failure:`, appendError);
    });
  };

  const declaration = getAgent(thread.agent);

  if (!declaration) {
    await failThread(`Unknown agent "${thread.agent}"`);

    return null;
  }

  const { userId } = thread;
  const threadId = thread.id;
  const agentName = declaration.name;
  const threadNotificationLevel =
    (startedEvent.payload.notification as NotificationLevel | undefined) ?? declaration.notification ?? 'normal';

  // The effective bundle (§7.4): the declaration's set, optionally narrowed
  // by the spawner via thread.started payload. Narrowing cannot widen —
  // resolution intersects, and 'all' still excludes consent servers.
  const narrowedTools = Array.isArray(startedEvent.payload.tools)
    ? startedEvent.payload.tools.filter((name): name is string => typeof name === 'string')
    : undefined;
  const bundle: ToolBundle = {
    declared: declaration.tools,
    ...(declaration.consentTools ? { extra: declaration.consentTools } : {}),
    ...(narrowedTools ? { narrowed: narrowedTools } : {}),
  };

  const abortController = new AbortController();
  const tools = createToolsApi({ userId, threadId, agentName, bundle });
  const files = createFilesApi(userId, agentName);

  const stateDir = path.join(AGENT_STATE_ROOT, agentName, userId);

  await mkdir(stateDir, { recursive: true });

  const pushEvent = async (type: string, payload: JsonObject) => {
    await appendEvent({
      type,
      actor: 'agent',
      agentName,
      userId,
      threadId,
      payload,
    });
  };

  const ctx: RunContext = {
    threadId,
    userId,
    signal: abortController.signal,

    pushEvent,

    progress: async text => {
      await pushEvent(THREAD_PROGRESS, { text });
    },

    complete: async (summary, meta) => {
      await pushEvent(THREAD_COMPLETED, {
        summary: summary as unknown as JsonObject,
        ...(meta?.title ? { title: meta.title } : {}),
        ...(meta?.description ? { description: meta.description } : {}),
      });
    },

    notify: async (level, text) => {
      await pushEvent(THREAD_NOTIFICATION, {
        level: clampNotificationLevel(level, threadNotificationLevel),
        text,
      });
    },

    spawn: async (childAgentName: string, input: JsonObject, options?: SpawnOptions) => {
      // Spawning is a declared need (the passport's `agents` list), not an
      // ambient right: anything not listed rejects.
      if (!declaration.agents?.includes(childAgentName)) {
        throw new Error(`Agent "${agentName}" may not spawn "${childAgentName}": it is not in its declaration's agents list`);
      }

      const childDeclaration = getAgent(childAgentName);

      if (!childDeclaration) {
        throw new Error(`Unknown agent "${childAgentName}"`);
      }

      // Consent-gated agents (§7.4): their capability level must not appear
      // as a side effect of another agent's plan — only the coordinator
      // starts them, on an explicit user request.
      if (childDeclaration.consent) {
        throw new Error(`Agent "${childAgentName}" is consent-gated: only the secretary starts it, on an explicit user request`);
      }

      const child = await startThread({
        userId,
        parentThreadId: threadId,
        agent: childAgentName,
        title: options?.title,
        input,
        notification: options?.notification,
        tools: options?.tools,
        icon: childDeclaration.icon,
        headless: childDeclaration.headless,
        actor: 'agent',
        agentName,
      });

      return { threadId: child.id };
    },

    cancelChild: async (childThreadId: string, reason: string) => {
      await appendEvent({
        type: THREAD_CANCEL,
        actor: 'agent',
        agentName,
        userId,
        threadId,
        targetThreadId: childThreadId,
        payload: { reason },
      });
    },

    // Inter-thread dialogue: one hop is enforced by append — a target that is
    // neither the parent nor a direct child rejects the call. File references
    // are validated against the workspace up front: a dead or foreign fileId
    // must reject the call, not surface later at the recipient.
    sendToChild: async (childThreadId: string, text: string, fileIds?: string[]) => {
      const validFileIds = await validateMessageFileIds(userId, fileIds);

      await appendEvent({
        type: THREAD_MESSAGE,
        actor: 'agent',
        agentName,
        userId,
        threadId,
        targetThreadId: childThreadId,
        payload: { text, ...(validFileIds.length ? { fileIds: validFileIds } : {}) },
      });
    },

    sendToParent: async (text: string, fileIds?: string[]) => {
      const validFileIds = await validateMessageFileIds(userId, fileIds);

      await appendEvent({
        type: THREAD_MESSAGE,
        actor: 'agent',
        agentName,
        userId,
        threadId,
        targetThreadId: thread.parentId,
        payload: { text, ...(validFileIds.length ? { fileIds: validFileIds } : {}) },
      });
    },

    harness: {
      sdkSession: options =>
        declaration.sdk === 'codex'
          ? createCodexSession(options, { tools, cwd: stateDir })
          : createClaudeSession(options, { tools, cwd: stateDir }),
    },

    tools,
    files,
    stateDir,
  };

  let run;

  try {
    const input = validateAgentInput(agentName, declaration.parameters, startedEvent.payload.input);

    // The declarative form is run by the platform's session runner; run() is
    // the imperative escape hatch (validate-agent guarantees exactly one).
    run = validateAgentRun(
      declaration.session
        ? createSessionRun(declaration, declaration.session, input, ctx)
        : declaration.run!(input, ctx),
      agentName,
    );
  } catch (error) {
    await failThread(getErrorMessage(error));

    return null;
  }

  // Self-termination: a proper agent writes its terminal via ctx.complete()
  // before finishing (or was cancelled — the terminal is already there). A
  // run that just ends, or dies, terminates the thread as failed; the append
  // is a no-op when a terminal already won (§4.3).
  run.finished.then(
    () => failThread('Run ended without a terminal'),
    error => failThread(getErrorMessage(error)),
  );

  console.log(`[agent-run:${threadId}] started agent "${agentName}"`);

  return {
    accept: event => {
      try {
        run.accept(event);
      } catch (error) {
        console.error(`[agent-run:${threadId}] accept failed:`, error);
      }
    },

    abort: reason => {
      abortController.abort(reason);
    },
  };
}
