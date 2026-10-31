// Typed payloads of the canonical events — the log's vocabulary as a type
// map, for consumers that narrow by `type`: the console's reducers, the
// shared projections (src/projections). Event.payload stays JsonObject in
// the envelope; this is a view over recorded history, not a validator, so a
// field is optional wherever some recorded event lacks it. Types only — the
// console imports this file (src/console/tsconfig.json).

import type { ContentBlock, Event, JsonObject, JsonValue, NotificationLevel, ThreadSummary, ToolResult } from './contract.ts';
import type { SessionState } from '../projections/session.ts';

// The human behind a user.message or a thread command: the user, and
// what the channel knew of them.
export type UserIdentity = {
  // The user behind the event (src/users) and their name as of it. Absent
  // only on what somebody wrote into a remote system's session (source
  // 'remote', src/remote/mirror.ts): a person Balabash knows by the
  // username alone.
  userId?: string;
  displayName?: string | null;
  // The channel's handle when it has one: a Telegram username, a remote
  // system's username.
  username?: string | null;
};

// A file a message refers to — user.message.files (stored by the channel
// adapter), thread.message.files (the sender's facts, src/core/file-blocks.ts):
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
    // A remote agent's thread (src/remote): the launch options by the
    // kind's schema; adopt — `input` names an existing session.
    remote?: boolean;
    options?: JsonObject;
    adopt?: boolean;
    // The attachments of the spawn prompt, as thread.message carries them:
    // fileIds — the references the model reads; files — their facts for
    // the reader. A local agent fetches them from storage by fileId; a
    // remote agent's driver streams them into the session at open.
    fileIds?: string[];
    files?: InboundFile[];
  };
  'thread.progress': { text: string };
  // fileIds — the references the model reads; files — the same files with
  // their facts for the reader, written together with fileIds (absent in
  // history recorded before them).
  'thread.message': { text: string; fileIds?: string[]; files?: InboundFile[] };
  'thread.notification': { text: string; level: NotificationLevel };
  'thread.completed': { summary: ThreadSummary; title?: string; description?: string };
  'thread.failed': { error: string };
  // The commands from above (the parent authors them, one hop down): the
  // coordinator's cancel, a surface's Stop/Cancel button (identity and
  // source of the human behind it).
  'thread.cancel': { reason: string; identity?: UserIdentity; source?: string };
  'thread.cancelled': { reason: string; requestedBy?: string; cascadeFromThreadId?: string };
  'thread.interrupt': { reason?: string; identity?: UserIdentity; source?: string } & JsonObject;
  // The remote thread's commands (src/remote), authored like the two above.
  'thread.finish': { reason?: string; identity?: UserIdentity; source?: string };
  'thread.pause': { identity?: UserIdentity; source?: string };
  'thread.decide': { askId: string; decision: string; identity?: UserIdentity; source?: string };

  // Dialogue.
  'user.message': {
    // Null for a message of files alone (Telegram, CCR and the console
    // write it so).
    text: string | null;
    identity?: UserIdentity;
    // The channel: 'web', 'telegram', 'ccr' — or 'remote' for a reply
    // somebody else wrote into a remote session, mirrored by the engine
    // (never forwarded back).
    source?: string;
    files?: InboundFile[];
    blocks?: ContentBlock[];
  };
  'agent.message': { content: ContentBlock[] };
  // A question of the agent that needs a human's decision (src/remote: the
  // approvals and sign-ins of a remote session; the remote engine writes
  // them): the id to decide by, the kind, the words, a link into the
  // external UI, the decisions offered (none — the link alone resolves it,
  // e.g. a sign-in). Resolved: the outcome, and who decided when it was
  // decided from Balabash.
  'agent.ask': { askId: string; kind: 'approval' | 'credential' | 'other'; text: string; link?: string; options: string[]; expiresAt?: string };
  'agent.ask.resolved': { askId: string; outcome: string; by?: { identity?: UserIdentity; source?: string } };

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
    // A remote session (src/remote): where a human looks at it in the
    // external system — the driver's link. Distinct from a Balabash thread
    // link: this one leaves the installation.
    remoteLink?: string;
  };
  'session.state': { state: SessionState };
  // A turn of the inner session (Claude: the result frame; Codex: the
  // turn.completed/failed event). Claude's totalCostUsd is cumulative over
  // the session; Codex's usage is the turn's; a failed Codex turn carries
  // the error.
  'session.turn': {
    durationMs?: number;
    durationApiMs?: number;
    numTurns?: number;
    totalCostUsd?: number;
    usage?: JsonObject;
    stopReason?: string | null;
    isError?: boolean;
    subtype?: string;
    error?: string;
  };
  'session.context': { totalTokens: number; maxTokens: number; percentage: number };
  // durationMs — how long the thought took as the journal observed it — the
  // harness's interval, API latency and frame delivery included, not the
  // model's own count: Claude — from the frame that bounds the model's
  // output before it (the tool result, the turn's init, the previous block
  // with content, the end of a retry's wait) to the frame carrying the
  // thought as its sole block; Codex — the item.started / item.completed
  // pair of the reasoning item, or since the previous completed item.
  // Absent when the journal had nothing to measure from.
  'session.thinking': { text: string; parentToolUseId?: string | null; durationMs?: number };
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
  // Another model than the session's served a response (Claude). source
  // 'refusal' — the CLI's own notice (system/model_refusal_fallback): the
  // model's safeguards declined the turn and the CLI retried it on its
  // fallback model; category — the refusal category the API named ('cyber',
  // 'bio', …; null when none), explanation — its prose, text — the CLI's
  // banner, all display-only. 'observed' — no notice: the response frame
  // itself named a model other than the one the session ran on (a switch
  // the CLI did not announce — server-side, an older CLI). scope 'session'
  // — the session's own thread: the CLI moves the session to the model for
  // good after a refusal; 'local' — a sub-agent's response alone came from
  // it, the session model is unchanged.
  'session.fallback': {
    from: string;
    to: string;
    scope: 'session' | 'local';
    source: 'refusal' | 'observed';
    category?: string | null;
    explanation?: string | null;
    text?: string;
  };
  // The model declined the turn (stop_reason refusal) and no fallback ran
  // (system/model_refusal_no_fallback): the turn ends with the refusal.
  'session.refusal': { model: string; category: string | null; explanation?: string | null; text?: string };
  // A notice of the CLI about the session — a fact the thread would
  // otherwise lose: mirror_error — the CLI dropped a transcript batch it
  // could not persist; permission_denied — a tool call was auto-denied
  // without a prompt; informational — a text banner of the loop (a hook's
  // block reason among them); notification — the REPL notification queue;
  // worker_shutting_down — the worker's own reason for going away;
  // conversation_reset — the transcript was mounted anew. text — one line
  // for a human; detail — the frame's own fields, camelCase.
  'session.notice': {
    kind: 'mirror_error' | 'permission_denied' | 'informational' | 'notification' | 'worker_shutting_down' | 'conversation_reset';
    level: 'info' | 'warning' | 'error';
    text: string;
    detail?: JsonObject;
  };

  // Integrations. The lifecycle events of a connection carry the row's id
  // (connectionId) so a projection keyed by id (the console's connections
  // domain) follows them; events recorded before the id was added lack it.
  'connection.pending': ConnectionRecord;
  // The row as it is after the flow (ConnectionRecord — the console folds it
  // whole) plus the flow's outcome; the row's fields are absent on events
  // recorded before the row was carried. The row may be another than the
  // flow's own (alreadyConnected: the consent landed on a connected account
  // — requestedAccount names the one asked for).
  'connection.completed': Partial<ConnectionRecord> & {
    server: string;
    account: string;
    name: string;
    identity?: string | null;
    alreadyConnected?: boolean;
    requestedAccount?: string;
  };
  'connection.failed': { server: string; account: string; name: string; error: string; connectionId?: string };
  'connection.reauthorization_required': {
    server: string;
    account: string;
    name: string;
    identity?: string | null;
    error: string;
    redirectedFromThreadId?: string;
    connectionId?: string;
  };
  'connection.renamed': { connectionId: string; server: string; account: string; name: string; previousName: string };
  // The row is gone: the user disconnected the account, or a flow's newborn
  // row turned out to be a twin of an established one (reason 'duplicate').
  'connection.disconnected': { connectionId: string; server: string; account: string; name: string; reason?: 'disconnected' | 'duplicate' };
  // Installation credentials asked of the operator
  // (src/capabilities/secret-requests.ts): the request opened — the row as
  // the snapshot shows it, journaled in its transaction, authored by the
  // thread that issued the link; the values landed — field names only,
  // addressed to that thread. requestId is absent on provisioned events
  // recorded before the request was journaled.
  'oauth_client.requested': SecretRequestRecord;
  'oauth_client.provisioned': { requestId?: string; server: string; fields: string[] };
  'secrets.requested': SecretRequestRecord;
  'secrets.provisioned': { requestId?: string; server: string; fields: string[] };

  // Registry events (src/core/registry-events.ts): written where the
  // registry tables change, the payload is the row as the console's
  // snapshot shows it (src/api/contract.ts views, dates as ISO strings) —
  // the reducers upsert it as a whole.
  'project.created': ProjectRecord;
  'project.updated': ProjectRecord;
  'project.archived': ProjectRecord;
  'project.unarchived': ProjectRecord;
  'schedule.task.created': TaskRecord;
  // The task left the registry: cancelled by a tool, or a one-shot task
  // fired and was consumed (reason 'consumed').
  'schedule.task.cancelled': TaskRecord & { reason?: 'cancelled' | 'consumed' };
  'app.published': { path: string; slug: string; name: string | null; description: string | null };
  'app.unpublished': { path: string; slug: string };
  // The name of Settings changed (PATCH /api/settings): the effective
  // name as /api/me reports it after the change — the stored workspace
  // name or the bound group's title — so every open tab folds it into its
  // session and follows.
  'settings.updated': SettingsRecord;
};

export type SettingsRecord = {
  workspaceName: string | null;
};

// The project row as the registry events carry it (ProjectView of the
// snapshot with ISO dates).
export type ProjectRecord = {
  id: string;
  title: string;
  slug: string;
  description: string;
  archived: boolean;
  // When it was archived; null on a live project and on one archived
  // before the date was kept.
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

// The scheduled task as the registry events carry it (TaskView with ISO
// dates; nextRunAt as of the event).
export type TaskRecord = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  kind: string;
  cron: string | null;
  at: string | null;
  note: string | null;
  command: string | null;
  cwd: string | null;
  timeoutMs: number | null;
  reportOnSuccess: boolean;
  createdBy: string | null;
  createdAt: string;
  nextRunAt: string | null;
};

// The connection row as connection.pending carries it (ConnectionView with
// ISO dates; never tokens).
export type ConnectionRecord = {
  connectionId: string;
  server: string;
  account: string;
  name: string;
  status: string;
  identity: string | null;
  scope: string | null;
  threadId: string | null;
  createdAt: string;
  updatedAt: string;
};

// An open request for installation credentials as secrets.requested /
// oauth_client.requested carry it (OpenSecretRequestView of the snapshot
// with an ISO date; the kind is the event's type; the asking agent and
// thread are the event's author). Never values.
export type SecretRequestRecord = {
  requestId: string;
  server: string;
  // The names of the fields asked for (secrets: the ${secret:NAME} keys of
  // the server's config; OAuth client: client_id, client_secret).
  fields: string[];
  requestedAt: string;
};

export type EventType = keyof EventPayloads;

// The session journal's vocabulary (src/harness/session-journal.ts).
export type SessionEventType = Extract<EventType, `session.${string}`>;

// One event narrowed to a known type.
export type EventOf<T extends EventType> = Omit<Event, 'type' | 'payload'> & { type: T; payload: EventPayloads[T] };

// The union of every known event shape — `switch (event.type)` narrows it.
export type TypedEvent = { [T in EventType]: EventOf<T> }[EventType];
