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
  status: ThreadStatus;
  summary: ThreadSummary | null;
  createdSeq: bigint;
  terminalSeq: bigint | null;
  createdAt: Date;
  updatedAt: Date;
};

export type NotificationLevel = 'silent' | 'normal' | 'urgent';

// ---------------------------------------------------------------------------
// Content (§9): canonical MCP-like blocks. Binary content never lives in the
// log — it is materialized into files on append, blocks carry fileId refs.

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; fileId: string }
  | { type: 'file'; fileId: string }
  | { type: 'resource_link'; uri: string; name?: string; mimeType?: string; size?: number };

export type ToolResult = {
  content: ContentBlock[];
  structuredContent?: JsonObject;
};

// ---------------------------------------------------------------------------
// Agent declaration (§7.1)

// Machine-readable domain event declared by an agent: types '<agent>.*',
// the first segment must equal the agent's name.
export type AgentEventDecl = {
  type: string;
  description: string;
  payloadSchema: JsonSchema;
};

export type AgentDeclaration = {
  name: string; // = spawn function name in the catalog
  description: string;
  icon?: string; // topic emoji
  parameters: JsonSchema; // spawn input
  tools: 'all' | string[]; // tool-server bundle (§7.4); 'all' excludes consent servers
  events?: AgentEventDecl[]; // domain types '<name>.*'
  notification?: NotificationLevel; // policy default (§11.3)
  resumable?: boolean; // reserved: thread resume after restart (§5.5)
  run(input: unknown, ctx: RunContext): AgentRun;
};

export type AgentRun = {
  accept(event: Event): void;
  finished: Promise<void>;
};

export type SpawnOptions = {
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
  complete(summary: ThreadSummary): Promise<void>; // thread.completed → parent
  notify(level: NotificationLevel, text: string): Promise<void>; // thread.notification, gated by policy

  spawn(agentName: string, input: JsonObject, options?: SpawnOptions): Promise<{ threadId: string }>;
  cancelChild(threadId: string, reason: string): Promise<void>;

  harness: HarnessApi; // injected core behaviour — instead of base classes
  tools: ToolsApi; // the bundled tool set; calls are journaled as tool.call.*
  files: FilesApi;
  stateDir: string; // persistent per-agent/per-user directory
};

// ---------------------------------------------------------------------------
// Injected core APIs. Shapes are finalized at their stages (harness — stage 3,
// tools/files — stages 2/4); kept minimal here so the contract compiles from
// day one without committing to details ahead of time.

export type SdkSessionOptions = {
  instructions?: string;
  model?: string;
  tools?: 'all' | string[];
} & JsonObject;

export type SdkSession = {
  close(): Promise<void>;
};

export type HarnessApi = {
  sdkSession(options: SdkSessionOptions): SdkSession;
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

export type FilesApi = {
  getDownloadUrl(fileId: string, filename?: string): Promise<string>;
};
