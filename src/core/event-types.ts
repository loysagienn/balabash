// Typed payloads of the canonical events — the log's vocabulary as a type
// map, for consumers that narrow by `type`: the console's reducers, the
// shared projections (src/projections). Event.payload stays JsonObject in
// the envelope; this is a view over recorded history, not a validator, so a
// field is optional wherever some recorded event lacks it. Types only — the
// console imports this file (src/console/tsconfig.json).

import type { ContentBlock, Event, JsonObject, JsonValue, NotificationLevel, ThreadSummary, ToolResult } from './contract.ts';
import type { SessionState } from '../projections/session.ts';

// The human behind a user.message, as the channel knew them.
export type UserIdentity = { firstName?: string; lastName?: string; username?: string };

// A file that arrived with a user.message (stored by the channel adapter):
// the fileId points into file storage, the rest describes it.
export type InboundFile = { fileId: string; contentType?: string | null; originalFilename?: string | null; sizeBytes?: number | null };

// What a native sub-agent or background task of a session has consumed.
export type SessionTaskUsage = { totalTokens: number; toolUses: number; durationMs: number };

// One item of the session's live plan (TodoWrite / todo list).
export type SessionPlanItem = { content: string; status: string; activeForm?: string };

export type EventPayloads = {
  // Lifecycle. thread.started is authored by the new thread itself
  // (threadId) and addressed to its parent (targetThreadId); the spawn-time
  // policy rides in the payload, the projection stores agent/title/project.
  'thread.started': {
    agent: string;
    title?: string;
    input?: string;
    headless?: boolean;
    icon?: string;
    notification?: NotificationLevel;
    tools?: string[];
    projectId?: string;
    projectSlug?: string;
  };
  'thread.progress': { text: string };
  'thread.message': { text: string; fileIds?: string[] };
  'thread.notification': { text: string; level: NotificationLevel };
  'thread.completed': { summary: ThreadSummary; title?: string; description?: string };
  'thread.failed': { error: string };
  'thread.cancel': { reason: string };
  'thread.cancelled': { reason: string; requestedBy?: string; cascadeFromThreadId?: string };
  'thread.interrupt': JsonObject;

  // Dialogue.
  'user.message': {
    text: string;
    identity?: UserIdentity;
    source?: string;
    files?: InboundFile[];
    blocks?: ContentBlock[];
  };
  'agent.message': { content: ContentBlock[] };

  // Journaled tool calls of the bundle (src/capabilities/tool-journal.ts).
  'tool.call.started': { callId: string; functionName: string; input: JsonObject };
  'tool.call.completed': { callId: string; functionName: string; serverName: string; toolName: string; result: ToolResult };
  'tool.call.failed': { callId: string; functionName: string; error: string };

  // Schedule and system.
  'schedule.fired': {
    slug: string;
    name: string;
    note?: string;
    runId?: string;
    output?: string;
    count?: number;
    since?: string;
    until?: string;
    newMessages?: number;
  } & JsonObject;
  'system.exception': {
    error: string;
    consumerName?: string;
    eventId?: string;
    eventType?: string;
    scope?: string;
    slug?: string;
    runId?: string;
    status?: string;
    exitCode?: number;
  };
  'system.restart.requested': { reason: string; requestedBy?: string };
  'system.restart.completed': {
    reason: string;
    requestSeq: number;
    redirectedFromThreadId?: string;
    rolledBack?: boolean;
    rollbackReason?: string;
    migrationsFailed?: string[];
  };

  // The SDK-session journal (src/harness/claude-sdk/session-journal.ts,
  // src/harness/codex-sdk/session-journal.ts): the course of a thread's
  // inner session, authored by the thread itself. camelCase views of the SDK
  // frames; nothing here is read back by a model. `parentToolUseId` ties the
  // frames of a native sub-agent (Agent tool) to the tool use that spawned
  // it; the bridge's own tools (mcp__balabash__*) are not here — they are
  // the tool.call.* events.
  'session.started': {
    model: string;
    tools: string[];
    mcpServers: { name: string; status: string }[];
    claudeCodeVersion?: string;
    effort?: string | null;
    cwd?: string;
  };
  'session.state': { state: SessionState };
  'session.turn': {
    durationMs?: number;
    durationApiMs?: number;
    numTurns?: number;
    costUsd?: number;
    usage?: JsonObject;
    stopReason?: string | null;
    isError?: boolean;
    subtype?: string;
  };
  'session.context': { totalTokens: number; maxTokens: number; percentage: number };
  'session.thinking': { text: string; parentToolUseId?: string | null };
  // Assistant text followed by more actions in the same turn (the final
  // text of a turn is the agent.message the runner delivers).
  'session.text': { text: string; parentToolUseId?: string | null };
  'session.tool.started': { toolUseId: string; name: string; input: JsonObject; parentToolUseId?: string | null };
  'session.tool.completed': {
    toolUseId: string;
    name: string;
    // The tool_result content as the model saw it (string or blocks; image
    // bytes replaced by { type: 'image', omitted: true }).
    result: JsonValue;
    isError: boolean;
    exitCode?: number;
    parentToolUseId?: string | null;
  };
  'session.tool.summary': { summary: string; precedingToolUseIds: string[] };
  'session.plan': { items: SessionPlanItem[] };
  'session.task.started': { taskId: string; toolUseId?: string; description: string; subagentType?: string; backgrounded?: boolean };
  'session.task.progress': {
    taskId: string;
    toolUseId?: string;
    description: string;
    usage: SessionTaskUsage;
    lastToolName?: string;
    summary?: string;
  };
  'session.task.completed': {
    taskId: string;
    toolUseId?: string;
    status: 'completed' | 'failed' | 'stopped';
    summary: string;
    usage?: SessionTaskUsage;
  };
  'session.compaction': { trigger: 'manual' | 'auto'; preTokens: number; postTokens?: number; durationMs?: number };
  'session.retry': { attempt: number; maxRetries: number; retryDelayMs: number; errorStatus: number | null; error?: string };

  // Integrations.
  'connection.completed': { server: string; account: string; name: string; identity?: string | null };
  'connection.failed': { server: string; account: string; name: string; error: string };
  'connection.reauthorization_required': {
    server: string;
    account: string;
    name: string;
    identity?: string | null;
    error: string;
    redirectedFromThreadId?: string;
  };
  'oauth_client.provisioned': { server: string; fields: string[] };
  'secrets.provisioned': { server: string; fields: string[] };
};

export type EventType = keyof EventPayloads;

// One event narrowed to a known type.
export type EventOf<T extends EventType> = Omit<Event, 'type' | 'payload'> & { type: T; payload: EventPayloads[T] };

// The union of every known event shape — `switch (event.type)` narrows it.
export type TypedEvent = { [T in EventType]: EventOf<T> }[EventType];
