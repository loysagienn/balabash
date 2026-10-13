// Agent contract — TYPES ONLY, no runtime values.
//
// The core is an esbuild bundle; dynamic capabilities are native import()s.
// A runtime value imported by both worlds would exist in two copies (bundle +
// ESM cache) — broken instanceof and singletons. So only data and types cross
// the boundary: an agent imports this module via `import type` (after type
// erasure its file has no runtime imports from the core), and core behaviour
// is injected through RunContext. The coordinator implements the same
// contract, but statically, inside src/ — dynamic agents cannot replace it.

import type { StorageBody } from '../files/storage.ts';

export type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];

export type JsonObject = {
  [key: string]: JsonValue;
};

// JSON Schema of an agent's input or a domain event payload. Opaque to the
// core: it is handed to the model / validator as-is.
export type JsonSchema = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Event envelope

export type EventActor = 'user' | 'system' | 'agent';

export type Event = {
  seq: bigint;
  id: string; // stable reference (refs, delivery idempotency)
  type: string;
  actor: EventActor;
  agentName: string | null; // set iff actor === 'agent'
  userId: string | null; // workspace; null = installation-level
  threadId: string | null; // author's thread; null = outside threads
  targetThreadId: string | null; // addressee; strictly one hop
  payload: JsonObject;
  schemaVersion: number;
  createdAt: Date;
};

// ---------------------------------------------------------------------------
// Threads

export type ThreadStatus = 'active' | 'completed' | 'failed' | 'cancelled';

// How many threads fall under each status (a listing's filters applied).
export type ThreadCounts = Record<ThreadStatus, number>;

// refs are event ids (Event.id) — the envelope's stable references.
export type ThreadSummary = {
  text: string;
  fileIds?: string[];
  refs?: string[];
};

export type Thread = {
  id: string;
  userId: string;
  parentId: string | null; // null = the workspace's main thread
  agent: string;
  title: string | null;
  // Retrospective self-description (~300 chars) from the thread's own
  // thread.completed; null for threads terminated from outside.
  description: string | null;
  status: ThreadStatus;
  summary: ThreadSummary | null;
  // The project the thread works for, named at spawn; null outside projects.
  projectId: string | null;
  // Spawn-time policy read from the thread's own thread.started (the row
  // does not store it): a headless thread has no user surface — the
  // dialogue is with the parent only, no topic, no web chat input.
  headless: boolean;
  // Spawn-time fact read from thread.started likewise: the thread mirrors a
  // session of a remote agent (RemoteAgentDeclaration) — it has no run in
  // this process, survives restarts and is driven by the remote engine
  // (src/remote). The commands finish/pause/decide exist for it alone.
  remote: boolean;
  createdSeq: bigint;
  terminalSeq: bigint | null;
  createdAt: Date;
  updatedAt: Date;
};

export type NotificationLevel = 'silent' | 'normal' | 'urgent';

// ---------------------------------------------------------------------------
// Content: canonical blocks of agent messages (agent.message payloads,
// send_message, send_file) — binary content by fileId reference. A different
// subject from tool results below.

export type ContentBlock =
  | { type: 'text'; text: string }
  // A stored file by reference, with its facts as the sender recorded them
  // (the words of resource_link; src/core/file-blocks.ts writes them from
  // the row): the reader names the attachment from the event itself.
  // History recorded before the facts carries the fileId alone — the
  // reader asks GET /api/files/:fileId/meta for it.
  | { type: 'image'; fileId: string; name?: string; mimeType?: string; size?: number }
  | { type: 'file'; fileId: string; name?: string; mimeType?: string; size?: number }
  | { type: 'resource_link'; uri: string; name?: string; mimeType?: string; size?: number };

// ---------------------------------------------------------------------------
// Tool results: the record is verbatim — a result is the raw MCP answer
// exactly as the server produced it, binary payloads (base64) included.
// Every transformation happens at read time, per projection, under the
// strict rule: structuredContent is primary; content is read only when
// structuredContent is absent.

export type ToolResultContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'audio'; data: string; mimeType: string }
  | { type: 'resource_link'; uri: string; name?: string; mimeType?: string; size?: number }
  | { type: 'resource'; resource: { uri?: string; mimeType?: string; text?: string; blob?: string } };

export type ToolResult = {
  content?: ToolResultContentBlock[];
  structuredContent?: JsonObject;
  // "The tool answered, albeit with an error" — verbatim from the server; a
  // structured error result is still a result. Breakage of the call itself
  // (transport, unknown tool) is a thrown error instead.
  isError?: boolean;
};

// ---------------------------------------------------------------------------
// Agent declaration

// Reasoning effort of the inner model, one scale for both SDKs: these are the
// Claude Agent SDK levels, and a strict subset of Codex's (which also knows
// minimal/ultra/persistent — not exposed), so a value passes through to either
// backend unchanged. 'high' is the platform default.
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

// First-party MCP servers of the Claude Code harness an agent may opt into by
// name (see src/harness/claude-sdk/native-servers.ts). Claude sessions only.
export type NativeMcpServerName = 'claude_design';

// Machine-readable domain event declared by an agent: types '<agent>.*',
// the first segment must equal the agent's name.
export type AgentEventDecl = {
  type: string;
  description: string;
  payloadSchema: JsonSchema;
};

// The declarative session agent (the preferred form): the whole lifecycle —
// spawn-prompt validation, the SDK session, rendering of incoming events,
// channel binding (user-facing thread vs headless parent dialogue by `headless`),
// the standard end_thread / send_file verbs, abort — is run by the platform.
// The agent supplies only data — plus, when the session needs machinery next
// to it (the designer's browser), an `environment` the platform builds and
// disposes around the session. An agent writes run() only when the lifecycle
// itself differs (the browser agent's operator protocol).
export type SessionAgentSpec = {
  instructions: string; // the inner session's system prompt
  // Renders the spawn prompt into the session-opening message. Optional: the
  // platform default is the prompt verbatim; declare it only for a genuinely
  // different opening move.
  initialMessage?(prompt: string): string;
  model?: string; // agent-level choice; omit for the SDK default
  effort?: EffortLevel; // reasoning effort; default 'high'
  preset?: 'bridge-only' | 'full'; // see SdkSessionOptions.preset
  // First-party harness MCP servers to attach (Claude agents only); see
  // SdkSessionOptions.nativeServers.
  nativeServers?: NativeMcpServerName[];
  // Session working directory; default — the run's stateDir. A function form
  // resolves per run from the calling user's id (e.g. a per-user workbench
  // under data/workspace/<userId>/...); the resolved directory is created
  // before the session starts.
  cwd?: string | ((userId: string) => string);
  // Per-run machinery a declaration cannot express statically (a browser next
  // to the session): built once per run after the working directory exists
  // and before the SDK session starts; its bridge tools join the base verbs;
  // disposed after the session ends, however it ends. Everything else of the
  // lifecycle stays the platform's.
  environment?(ctx: RunContext, cwd: string): Promise<SessionEnvironment>;
};

export type SessionEnvironment = {
  extraTools?: SdkBridgeTool[]; // bridge-only tools on top of the base verbs
  dispose?(): Promise<void>;
};

export type AgentDeclaration = {
  name: string; // = spawn function name in the catalog
  description: string;
  icon?: string; // thread icon, shown by the user surface (e.g. the Telegram topic emoji)
  sdk: 'claude' | 'codex'; // provider behind ctx.harness.sdkSession()
  // Spawn input is the same for every agent: one non-empty text prompt — the
  // task plus everything it should start from. No per-agent schema.
  // The agent's tool passport: the tool-server names it gets, listed
  // explicitly — no server reaches an agent that did not name it. A spawner's
  // narrowing can still shrink the list.
  tools: string[];
  // Sub-agents this agent may spawn (part of the passport: spawning is a
  // declared need, not an ambient right). ctx.spawn rejects anything not
  // listed; omitted = spawns nothing. A session agent with a non-empty list
  // gets the child-operating bridge tools (spawn_agent, send_to_thread,
  // cancel_thread) — spawning makes it the child's operator.
  agents?: string[];
  events?: AgentEventDecl[]; // domain types '<name>.*'
  // A headless agent's thread has no user surface (no Telegram topic, no web chat): the user
  // is not a participant — the agent talks to its parent via progress/summary
  // and receives forwarded input as thread.message.
  headless?: boolean;
  notification?: NotificationLevel; // policy default
  resumable?: boolean; // reserved: thread resume after restart
  // Exactly one of `session` (declarative, preferred) and `run` (imperative).
  session?: SessionAgentSpec;
  run?(prompt: string, ctx: RunContext): AgentRun;
};

// ---------------------------------------------------------------------------
// Remote agents: the third form of a catalog agent — its session runs in an
// external system (Avride agents, ...); the thread in Balabash is a mirror of
// that session, kept by the remote engine (src/remote) through a driver that
// translates the external system into the neutral dialogue vocabulary below.
// Only installation extensions declare them (data/remote-agents/<name>.ts,
// export start(ctx) → RemoteAgentDeclaration); the repository ships none.
// The engine that drives them: src/remote/engine.ts.

export type RemoteAgentDeclaration = {
  kind: 'remote';
  name: string; // = the file name; /^[a-z][a-z0-9_]*$/, never a repository agent's name
  description: string; // what the system is and when to start it — read by the spawners
  icon?: string;
  notification?: NotificationLevel; // the thread's default policy, as for every agent
  // The launch parameters the external system knows (harness, model, effort,
  // resources ...): an object JSON Schema whose properties carry description
  // and default; every field optional (no `required`). The spawn verb of the
  // kind takes `options` by this schema — the one exception to "every agent's
  // input is one prompt", for the kinds of extensions only.
  options?: JsonSchema;
  // Installation secrets the driver reads through ctx.secrets (names); the
  // operator provisions them through the secrets form like an external
  // server's — the kind appears among the installation services.
  secrets?: string[];
  driver: RemoteDriver;
};

export type RemoteDriverContext = {
  // The installation secrets of this kind (ExternalServerSecret rows with
  // server = the kind's name); a missing one throws.
  secrets: { get(name: string): Promise<string> };
  // Stored files: open(fileId) streams an attachment into the session;
  // ingest stores a file fetched out of it.
  files: RemoteDriverFilesApi;
};

// The same surface a local tool server gets (LocalToolFilesApi); the body
// type is the storage layer's.
export type RemoteDriverFilesApi = {
  ingest(input: {
    body: StorageBody;
    userId?: string | null;
    originalFilename?: string | null;
    contentType?: string | null;
    sizeBytes?: number | null;
    scope?: string | null;
  }): Promise<FileRef>;
  get(fileId: string): Promise<FileRef>;
  open(fileId: string): Promise<ReadableStream<Uint8Array>>;
};

// One read of the session since the cursor: the driver's opaque position
// (stored as is, advanced together with the mirror), the phase the session
// is in, and the items in the order of the external system. A driver keeps
// no state beyond the cursor; read is idempotent and has no side effects on
// the other side. The cursor must carry enough for the driver to continue
// from it even when the external system's own cursor lapsed: on such a
// lapse the driver re-reads from the start, skips what the cursor says was
// already handed out, and reports `resynced` (the engine notes it in the
// mirror). Every verb of the driver is bounded in time by the engine (a
// minute); a verb that overruns is an error of that verb, not of the
// thread.
export type RemoteRead = {
  cursor: JsonValue;
  // working — a turn is in flight; idle — the session waits; asking — a
  // question needs a human; gone — the session is irrecoverably lost.
  phase: 'working' | 'idle' | 'asking' | 'gone';
  nextReadInSec?: number; // a hint; the engine clamps it to [5 s, 1 h]
  items: RemoteItem[];
  // The cursor could not be served as it was: the driver re-read from the
  // start and continued from what the cursor said was already handed out —
  // the engine notes the resync in the mirror.
  resynced?: boolean;
};

// The dialogue vocabulary every driver translates into. messageId is OUR
// id of a prompt (RemoteDriver.say / open hand it to the system as the
// message id), so the echo of our own prompt is recognised and not mirrored
// twice; text and output are verbatim — but never base64 blobs (bytes cross
// only through fetchFile) and never secrets; every string is untrusted text
// of the external system.
//
// turn.started.messageId — our id when the turn was opened by our prompt
// (a driver that knows it must hand it over: the closing summary's turn is
// told apart by it; without it the engine takes the first turn opened
// after the summary was asked for).
// text — a WHOLE message of the agent, not a delta: one item is one reply
// (a driver over a streaming system hands the message over once it is
// complete).
export type RemoteItem =
  | { kind: 'turn.started'; turnId: string; messageId?: string }
  | { kind: 'prompt'; messageId?: string; author?: string; text: string }
  | { kind: 'text'; turnId: string; text: string }
  | { kind: 'tool.started'; turnId: string; callId: string; name: string; input: JsonObject }
  | { kind: 'tool.finished'; turnId: string; callId: string; name: string; output: string; isError?: boolean }
  // text — the turn's last reply ('' when none)
  | { kind: 'turn.finished'; turnId: string; outcome: 'completed' | 'failed' | 'stopped'; text: string }
  // terminal — the turn failed; the thread itself never fails for it
  | { kind: 'error'; text: string; terminal: boolean }
  | {
      kind: 'ask.opened';
      askId: string;
      askKind: 'approval' | 'credential' | 'other';
      text: string;
      link?: string;
      options: string[]; // the decisions a human may answer with; [] when only the link resolves it
      expiresAt?: string;
    }
  | { kind: 'ask.closed'; askId: string; outcome: string }
  | { kind: 'artifact'; title: string; uri: string; mimeType?: string };

// The verbs with a side effect on the other side (open, say, answer) may be
// REPEATED by the engine with the same messageId / askId: a crash between
// the verb and its record here replays the verb after the restart. A driver
// makes them idempotent by that id (a prompt already accepted under the
// id is not sent twice; a decision already given is not given again) —
// the external system's own idempotency where it has one, the driver's
// check otherwise.
export type RemoteDriver = {
  // Start a new session with the prompt and the options (by the declared
  // schema); files — attachments of the prompt. ref — the session in the
  // external system (opaque to the core); link — where a human looks at it.
  // messageId is stable for the thread: a repeat opens no second session.
  open(
    ctx: RemoteDriverContext,
    input: { prompt: string; options: JsonObject; files: FileRef[]; messageId: string },
  ): Promise<{ ref: string; link?: string; title?: string }>;
  // Adoption: does the session exist, and how is it called. cursor — where
  // the mirror starts: absent, the whole history of the session is mirrored
  // (every turn and tool call as events of the thread); a driver that
  // would rather start from now hands the position of the present.
  describe(ctx: RemoteDriverContext, ref: string): Promise<{ exists: boolean; link?: string; title?: string; cursor?: JsonValue }>;
  // cursor null = from the beginning.
  read(ctx: RemoteDriverContext, input: { ref: string; cursor: JsonValue | null }): Promise<RemoteRead>;
  say(ctx: RemoteDriverContext, input: { ref: string; text: string; files: FileRef[]; messageId: string }): Promise<void>;
  answer(ctx: RemoteDriverContext, input: { ref: string; askId: string; decision: string }): Promise<void>;
  // Interrupt the turn in flight; the session stays.
  stop(ctx: RemoteDriverContext, ref: string): Promise<void>;
  // A file of the session by path; null when it is not available (the
  // sandbox asleep, the path missing).
  fetchFile?(
    ctx: RemoteDriverContext,
    input: { ref: string; path: string },
  ): Promise<{ body: StorageBody; filename: string; contentType?: string } | null>;
  // The sessions a human may adopt.
  list?(ctx: RemoteDriverContext): Promise<{ ref: string; title: string; link?: string }[]>;
};

export type AgentRun = {
  accept(event: Event): void;
  // Soft stop (thread.interrupt): abort the current turn, keep the run alive
  // and wait for the next message. Optional — an imperative run without an
  // interruptible turn may omit it. Never throws; a no-op when idle.
  interrupt?(): void;
  finished: Promise<void>;
};

export type SpawnOptions = {
  title?: string; // thread title — every user surface shows it (e.g. as the Telegram topic name)
  tools?: string[]; // narrow the child's bundle; widening is not possible
  notification?: NotificationLevel;
  // The slug of the project the child works for: resolved against the
  // workspace registry at spawn (an unknown slug rejects the spawn) and
  // recorded in thread.started — the thread ↔ project link of the log.
  project?: string;
  // Remote kinds only (RemoteAgentDeclaration): the launch parameters by the
  // kind's options schema, and adoption — the prompt is then the reference
  // of an existing session rather than a task.
  options?: JsonObject;
  adopt?: boolean;
};

export type RunContext = {
  threadId: string;
  userId: string;
  signal: AbortSignal;

  // Canonical events on the run's behalf + declared domain events.
  pushEvent(type: string, payload: JsonObject): Promise<void>;
  progress(text: string): Promise<void>; // thread.progress → parent
  // thread.completed → parent. The optional retrospective self-description
  // (title: 2–5 words naming the work; description: ~300 chars) rides the
  // terminal payload and updates the thread row.
  complete(summary: ThreadSummary, meta?: { title?: string; description?: string }): Promise<void>;
  notify(level: NotificationLevel, text: string): Promise<void>; // thread.notification, gated by policy

  spawn(agentName: string, prompt: string, options?: SpawnOptions): Promise<{ threadId: string }>;
  cancelChild(threadId: string, reason: string): Promise<void>;
  // thread.finish to a remote child: its session is asked for a closing
  // summary, which completes the thread (src/remote).
  finishChild(threadId: string): Promise<void>;

  // Inter-thread dialogue (thread.message, one hop): drive a child agent with
  // instructions, or answer the parent that drives this run. The counterpart
  // arrives through accept() as a thread.message event. A message is text
  // plus optional file references (workspace fileIds) — the universal way to
  // hand a file to the interlocutor; bytes never travel through messages.
  sendToChild(threadId: string, text: string, fileIds?: string[]): Promise<void>;
  sendToParent(text: string, fileIds?: string[]): Promise<void>;

  harness: HarnessApi; // injected core behaviour — instead of base classes
  tools: ToolsApi; // the bundled tool set; calls are journaled as tool.call.*
  files: FilesApi;
  stateDir: string; // persistent per-agent/per-user directory
};

// ---------------------------------------------------------------------------
// Injected core APIs. The SDK session shape is finalized at stage 3; the
// tool-server bundle joins ToolsApi at stage 4.

// A bridge-only tool the agent adds on top of its ToolsApi bundle (e.g. the
// a child agent's end_thread). Lives only inside the session's MCP bridge:
// it is not journaled as tool.call.* — the agent reflects its consequences
// into the log itself (complete(), pushEvent()).
export type SdkBridgeTool = {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  // Birth contract, same as every tool of ours: return data or throw.
  // The bridge shapes the structured result (object → structuredContent,
  // primitive/array → {result}, throw → {error: {message, details?}} +
  // isError). No content blocks, no bytes.
  handler(args: JsonObject): Promise<JsonValue>;
};

export type SdkSessionOptions = {
  instructions: string; // the inner session's system prompt
  initialMessage: string; // the first user message opening the session
  model?: string; // agent-level choice; omit for the SDK default
  effort?: EffortLevel; // reasoning effort; default 'high'
  extraTools?: SdkBridgeTool[]; // bridge-only tools on top of ctx.tools
  // 'bridge-only' (default): the inner model sees the Balabash bridge and
  // nothing else. 'full' unlocks the provider's native tool preset for host
  // work; interpretation is SDK-specific (claude: the claude_code preset plus
  // project settings from cwd; codex sessions are full by construction —
  // Codex's native tools plus the bridge, in the app's isolated CODEX_HOME).
  preset?: 'bridge-only' | 'full';
  cwd?: string; // session working directory; default — the run's stateDir
  // First-party MCP servers of the Claude Code harness to attach next to the
  // bridge (e.g. claude_design). The harness authenticates them itself with
  // the host's Claude login; ignored by the codex backend.
  nativeServers?: NativeMcpServerName[];
  // Extra environment variables for the session process, merged over the app
  // process environment (e.g. WORKSPACE_DB — the workspace database path).
  env?: Record<string, string>;
};

// One completed session turn: the final text the inner model produced. A
// failed turn ends the iteration with a thrown error.
export type SdkTurn = {
  text: string;
  // The turn was cut short by interrupt(); text is empty — whatever the
  // model produced before the stop already rode the live stream.
  interrupted?: true;
};

export type AgentSdkSession = {
  // Enqueue the next user message; throws after close().
  push(text: string): void;
  // Completed turns, in order; ends after close(), throws on turn failure.
  turns: AsyncIterable<SdkTurn>;
  // Re-diff the bridge against ctx.tools after a catalog change; never rejects.
  syncTools(): Promise<void>;
  // Interrupt the turn in flight: the inner model stops, the interrupted turn
  // still closes through `turns` (empty text, `interrupted: true`) and the
  // session stays open for the next push. A no-op when idle; never rejects.
  // Optional — a harness without a soft stop (codex) omits it.
  interrupt?(): Promise<void>;
  // End the input queue and the underlying session. Idempotent.
  close(): void;
};

export type HarnessApi = {
  sdkSession(options: SdkSessionOptions): AgentSdkSession;
};

export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: JsonSchema;
};

export type ToolsApi = {
  list(): Promise<ToolDefinition[]>;
  call(name: string, args: JsonObject): Promise<ToolResult>;
};

// The platform's one file reference: the File model's fields without
// the storage internals (bucket/objectKey), dates as ISO 8601 strings — the
// shape is JSON-ready and identical in every tool result of ours. `url` is
// the only ephemeral field: a presigned, time-limited download URL a
// producer adds deliberately (e.g. storage_get_file); the transcript strips it.
export type FileRef = {
  id: string;
  userId: string | null;
  contentType: string | null;
  sizeBytes: number | null;
  etag: string | null;
  originalFilename: string | null;
  scope: string | null;
  width: number | null;
  height: number | null;
  uploadedAt: string | null;
  createdAt: string;
  updatedAt: string;
  url?: string;
};

export type IngestFileInput = {
  body: NodeJS.ReadableStream | Uint8Array | string;
  filename?: string | null;
  contentType?: string | null;
  sizeBytes?: number | null;
};

export type FilesApi = {
  // Workspace-scoped: a fileId from outside the user boundary reads as missing.
  getInfo(fileId: string): Promise<FileRef>;
  getDownloadUrl(fileId: string, filename?: string): Promise<string>;
  // Store new content in the run's workspace (the file's userId is the run's
  // user). The storage scope is the agent's name.
  ingest(input: IngestFileInput): Promise<FileRef>;
};
