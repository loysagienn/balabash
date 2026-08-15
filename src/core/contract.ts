// Agent contract (design doc §7.1) — TYPES ONLY, no runtime values.
//
// The core is an esbuild bundle; dynamic capabilities are native import()s.
// A runtime value imported by both worlds would exist in two copies (bundle +
// ESM cache) — broken instanceof and singletons. So only data and types cross
// the boundary: an agent imports this module via `import type` (after type
// erasure its file has no runtime imports from the core), and core behaviour
// is injected through RunContext. The coordinator implements the same
// contract, but statically, inside src/ — dynamic agents cannot replace it.

export type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];

export type JsonObject = {
  [key: string]: JsonValue;
};

// JSON Schema of an agent's input or a domain event payload. Opaque to the
// core: it is handed to the model / validator as-is.
export type JsonSchema = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Event envelope (§4.1)

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
// Threads (§5)

export type ThreadStatus = 'active' | 'completed' | 'failed' | 'cancelled';

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
  createdSeq: bigint;
  terminalSeq: bigint | null;
  createdAt: Date;
  updatedAt: Date;
};

export type NotificationLevel = 'silent' | 'normal' | 'urgent';

// ---------------------------------------------------------------------------
// Content (§9): canonical blocks of agent messages (agent.message payloads,
// send_message, send_file) — binary content by fileId reference. A different
// subject from tool results below.

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; fileId: string }
  | { type: 'file'; fileId: string }
  | { type: 'resource_link'; uri: string; name?: string; mimeType?: string; size?: number };

// ---------------------------------------------------------------------------
// Tool results (§9): the record is verbatim — a result is the raw MCP answer
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
// Agent declaration (§7.1)

// Reasoning effort of the inner model (the Claude Agent SDK scale; the codex
// SDK ignores it). 'high' is the platform default.
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

// Machine-readable domain event declared by an agent: types '<agent>.*',
// the first segment must equal the agent's name.
export type AgentEventDecl = {
  type: string;
  description: string;
  payloadSchema: JsonSchema;
};

// The declarative session agent (the preferred form): the whole lifecycle —
// input validation against `parameters`, the SDK session, rendering of
// incoming events, channel binding (forum topic vs headless parent dialogue
// by `headless`), the standard end_thread / send_file verbs, abort — is run
// by the platform. The agent supplies only data. An agent writes run() only
// when it needs machinery a declaration cannot express (e.g. the browser's
// Chromium environment).
export type SessionAgentSpec = {
  instructions: string; // the inner session's system prompt
  // Renders the validated spawn input into the session-opening message.
  // Optional: the platform default (session-run) renders the standard
  // "Task from your operator / Context" template from input.task and
  // input.context; declare it only for a genuinely different shape.
  initialMessage?(input: JsonObject): string;
  model?: string; // agent-level choice; omit for the SDK default
  effort?: EffortLevel; // reasoning effort; default 'high' (claude SDK only)
  preset?: 'bridge-only' | 'full'; // see SdkSessionOptions.preset
  // Session working directory; default — the run's stateDir. A function form
  // resolves per run from the calling user's id (e.g. a per-user workbench
  // under data/workspace/<userId>/...); the resolved directory is created
  // before the session starts.
  cwd?: string | ((userId: string) => string);
};

export type AgentDeclaration = {
  name: string; // = spawn function name in the catalog
  description: string;
  icon?: string; // topic emoji
  sdk: 'claude' | 'codex'; // provider behind ctx.harness.sdkSession()
  parameters: JsonSchema; // spawn input
  tools: 'all' | string[]; // tool-server bundle (§7.4); 'all' excludes consent servers
  // Consent servers granted on top of `tools` (§7.4): naming one here is the
  // explicit ask 'all' deliberately does not make. A spawner's narrowing can
  // still drop them.
  consentTools?: string[];
  // A consent-gated agent (§7.4 applied to agents): its capability level
  // (e.g. full host access) must not appear as a side effect — only the
  // coordinator spawns it, and only on an explicit user request.
  consent?: boolean;
  // Sub-agents this agent may spawn (part of the passport: spawning is a
  // declared need, not an ambient right). ctx.spawn rejects anything not
  // listed; omitted = spawns nothing. A session agent with a non-empty list
  // gets the child-operating bridge tools (spawn_agent, send_to_thread,
  // cancel_thread) — spawning makes it the child's operator. Consent-gated
  // agents stay coordinator-only regardless of this list.
  agents?: string[];
  events?: AgentEventDecl[]; // domain types '<name>.*'
  // A headless agent's thread has no user surface (no forum topic): the user
  // is not a participant — the agent talks to its parent via progress/summary
  // and receives forwarded input as thread.message.
  headless?: boolean;
  notification?: NotificationLevel; // policy default (§11.3)
  resumable?: boolean; // reserved: thread resume after restart (§5.5)
  // Exactly one of `session` (declarative, preferred) and `run` (imperative).
  session?: SessionAgentSpec;
  run?(input: unknown, ctx: RunContext): AgentRun;
};

export type AgentRun = {
  accept(event: Event): void;
  finished: Promise<void>;
};

export type SpawnOptions = {
  title?: string; // thread title — the surface shows it (forum topic name)
  tools?: string[]; // narrow the child's bundle; widening is not possible
  notification?: NotificationLevel;
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

  spawn(agentName: string, input: JsonObject, options?: SpawnOptions): Promise<{ threadId: string }>;
  cancelChild(threadId: string, reason: string): Promise<void>;

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
  // Birth contract (§9), same as every tool of ours: return data or throw.
  // The bridge shapes the structured result (object → structuredContent,
  // primitive/array → {result}, throw → {error: {message, details?}} +
  // isError). No content blocks, no bytes.
  handler(args: JsonObject): Promise<JsonValue>;
};

export type SdkSessionOptions = {
  instructions: string; // the inner session's system prompt
  initialMessage: string; // the first user message opening the session
  model?: string; // agent-level choice; omit for the SDK default
  effort?: EffortLevel; // reasoning effort; default 'high' (claude SDK only)
  extraTools?: SdkBridgeTool[]; // bridge-only tools on top of ctx.tools
  // 'bridge-only' (default): the inner model sees the Balabash bridge and
  // nothing else. 'full' unlocks the provider's native tool preset for host
  // work; interpretation is SDK-specific (claude: the claude_code preset plus
  // project settings from cwd; codex sessions are full by construction).
  preset?: 'bridge-only' | 'full';
  cwd?: string; // session working directory; default — the run's stateDir
};

// One completed session turn: the final text the inner model produced. A
// failed turn ends the iteration with a thrown error.
export type SdkTurn = {
  text: string;
};

export type AgentSdkSession = {
  // Enqueue the next user message; throws after close().
  push(text: string): void;
  // Completed turns, in order; ends after close(), throws on turn failure.
  turns: AsyncIterable<SdkTurn>;
  // Re-diff the bridge against ctx.tools after a catalog change; never rejects.
  syncTools(): Promise<void>;
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

// The platform's one file reference (§9): the File model's fields without
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
