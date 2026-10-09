// Wire contract of the /api namespace. The Next.js client (src/web) imports
// these TYPE-ONLY: no runtime code crosses the process boundary. On the wire
// every body goes through serialize-json in both directions, so bigint and
// Date survive as their marked forms and these types describe the RESTORED
// values, not the raw JSON.

// Every error, any endpoint, one shape.
export type ApiErrorBody = {
  error: {
    code: string;
    message: string;
  };
};

export type AuthRequest = {
  code: string;
};

// POST /api/auth/console-code: no body, no session; 204 with an empty body —
// the code goes to the server's stdout, never over the wire. 429 when one
// was printed moments ago.

export type MeResponse = {
  userId: string;
  // Human-readable workspace name (the bound Telegram group's title when that
  // channel is on; null otherwise).
  workspaceName: string | null;
  // The workspace's main thread (the coordinator's root thread) — the
  // header's «to the coordinator» link target. Null only before activation.
  mainThreadId: string | null;
};

export type LogoutResponse = {
  ok: true;
};

// ---------------------------------------------------------------------------
// The workspace window (read-only): threads and their event feeds. The core
// envelope types are re-exported so the client names the same shapes the
// server serves — still type-only, still one source of truth.

export type {
  ContentBlock,
  Event,
  EventActor,
  JsonObject,
  JsonValue,
  Thread,
  ThreadCounts,
  ThreadStatus,
  ThreadSummary,
} from '../core/contract.ts';

import type { Event, Thread, ThreadCounts, ThreadStatus } from '../core/contract.ts';

// GET /api/threads query: everything optional, everything scoped to the
// session's userId on the server. Newest first; `before` is the cursor —
// the nextCursor of the previous page (a thread's createdSeq, decimal).
export type ThreadsQuery = {
  status?: ThreadStatus;
  // A thread id, or the literal "null" for root threads.
  parentId?: string;
  // A project id (Thread.projectId): threads spawned for that project.
  projectId?: string;
  // An agent name (Thread.agent).
  agent?: string;
  // A case-insensitive substring of the title, the description or the
  // summary text (at most 200 characters).
  q?: string;
  createdAtGte?: string; // ISO date-time
  createdAtLte?: string; // ISO date-time
  before?: string; // decimal createdSeq cursor
  limit?: number;
};

export type ThreadsResponse = {
  threads: Thread[];
  // createdSeq of the last returned thread when the page came back full —
  // pass it as ?before= to continue into older threads; null = exhausted.
  // createdSeq is unique, so equal createdAt values cannot split a page.
  nextCursor: bigint | null;
  // With the first page (no `before`): how many threads of the workspace
  // fall under each status with the same filters, status aside — the
  // segments of the list. Absent on later pages.
  counts?: ThreadCounts;
};

export type ThreadResponse = {
  thread: Thread;
  // Spawn-time policy from the thread.started payload: a headless thread has
  // no user surface — the chat is the read-only dialogue with the parent and
  // POST /messages answers 409.
  headless: boolean;
};

// GET /api/threads/:id/events: cursor-paginated by the global event seq,
// which is unique and follows insert order, so events sharing a createdAt
// timestamp still page deterministically. Two directions, exclusive:
// - default / ?before=<seq>: newest first — pass the previous page's
//   nextCursor as ?before= to continue into older events (history);
// - ?after=<seq>: oldest first, strictly newer than seq — the live tail a
//   chat polls with the seq of the last event it has (?after=0 = from the
//   beginning).
export type ThreadEventsResponse = {
  events: Event[];
  // seq of the last returned event when the page came back full — pass it
  // as ?before= (or ?after=, in the same direction) to continue; null = the
  // page was short, the feed is exhausted for now.
  nextCursor: bigint | null;
};

// POST /api/threads/:id/messages: the web chat's inbound. Appends a
// user.message to one of the session's own threads (the main thread or an
// active child); the event comes back as written. A thread that is not
// active answers 409 (thread_closed), a headless one 409 (thread_headless).
//
// GET /api/files/:fileId streams a stored file of the workspace (the
// attachments of user/agent messages: payload.files[].fileId, content
// blocks' fileId) — inline, ?download=1 for an attachment; a foreign or
// missing id is the same 404.
export type PostThreadMessageRequest = {
  text: string;
};

export type PostThreadMessageResponse = {
  event: Event;
};

// POST /api/threads/:id/interrupt — a soft stop of the turn in flight (the
// run stays, waits for the next message); POST /api/threads/:id/cancel —
// ends the thread (the router aborts the run, thread.cancelled follows in
// the log). Both answer with the command event as written; the outcome
// itself arrives through the event stream. 409 thread_closed for a thread
// that is not active, 409 thread_main for the main thread (eternal —
// nothing addresses it from above). Mutations under the session are refused
// from another origin (403 cross_site — src/api/origin.ts).
export type CancelThreadRequest = {
  reason?: string; // ≤ 1 000 chars; default "cancelled by the operator"
};

export type ThreadCommandResponse = {
  event: Event;
};

// ---------------------------------------------------------------------------
// The workspace file area (read-only): the user's window into
// data/workspace/<userId>/files. GET /api/workspace/node?path=<rel> answers
// with a polymorphic node — a directory listing or one file's metadata — so
// a deep link learns what it points at in one request. Raw content streams
// from the root namespace instead: GET /files/<rel> (bytes + honest
// content-type, no JSON envelope — not described here). Inline by default,
// ?download=1 answers as an attachment.

export type WorkspaceFileMeta = {
  // Relative path inside the file area — the shared currency of the API,
  // the tools and the URLs.
  path: string;
  // Null only when the file vanished between listing and stat.
  sizeBytes: number | null;
  modifiedAt: string | null; // ISO date-time
  // Agent-written annotations from the workspace database.
  title: string | null;
  description: string | null;
  // Guessed from the extension; drives the client's viewer registry.
  mediaType: string;
};

export type WorkspaceNodeResponse =
  | {
      kind: 'dir';
      // '' is the file-area root; a missing root answers as an empty dir.
      path: string;
      directories: string[];
      files: WorkspaceFileMeta[];
    }
  | {
      kind: 'file';
      path: string;
      file: WorkspaceFileMeta;
    };

// ---------------------------------------------------------------------------
// LLM request telemetry (read-only): the llm_requests table minus rawUsage,
// scoped to the session's userId. Serves the /llm-usage chart — the raw
// last-N series, no server-side aggregation. Token counts are null (not 0)
// when a request failed before returning usage.

export type LlmRequestItem = {
  id: string;
  createdAt: Date;
  threadId: string | null;
  provider: string;
  model: string;
  responseId: string | null;
  previousResponseId: string | null;
  lastSeq: bigint | null;
  iteration: number | null;
  status: string;
  error: string | null;
  serviceTier: string | null;
  durationMs: number | null;
  inputTokens: number | null;
  cachedTokens: number | null;
  cacheWriteTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
};

// GET /api/llm-requests?limit=N — the newest N rows, returned oldest-first
// so the client draws left to right without re-sorting.
export type LlmRequestsResponse = {
  requests: LlmRequestItem[];
};

// ---------------------------------------------------------------------------
// Secret provisioning (the trusted window): the API exposes field METADATA
// only — submitted values go straight to storage and never come back, not in
// responses, not in events, not in logs.

export type SecretRequestField = {
  key: string;
  label: string;
  description: string;
  required: boolean;
  // Hint for the input: secrets are masked, identifiers are not.
  secret: boolean;
};

export type SecretRequestView = {
  id: string;
  // What lands where: installation secrets of an external MCP server, or a
  // manual installation-level OAuth client.
  kind: 'external-secrets' | 'oauth-client';
  server: string;
  fields: SecretRequestField[];
};

export type SecretRequestResponse = {
  request: SecretRequestView;
};

export type ProvisionSecretsRequest = {
  values: Record<string, string>;
};

export type ProvisionSecretsResponse = {
  ok: true;
};

// --------------------------------------------------------------------------
// Apps platform: publication management (GET /api/apps, POST
// /api/apps/publish, POST /api/apps/unpublish).

export type AppListingView = {
  path: string;
  name: string | null;
  description: string | null;
  manifestError: string | null;
  slug: string | null;
};

export type AppsResponse = {
  apps: AppListingView[];
  // Absolute base of public app URLs, no trailing slash (src/apps/urls.ts):
  // https://<APPS_DOMAIN> with an apps domain, https://<DOMAIN>/a without
  // one — the client builds <publicAppsBase>/<slug>.
  publicAppsBase: string;
};

export type PublishAppRequest = {
  path: string;
  slug: string;
};

export type UnpublishAppRequest = {
  path?: string;
  slug?: string;
};

export type PublicationResponse = {
  slug: string;
  path: string;
};

// ---------------------------------------------------------------------------
// The console's snapshot (GET /api/snapshot): the server-side projections
// the store hydrates from, stamped with the log position they reflect. The
// tail (GET /api/events/stream?after=<asOfSeq>) continues from there —
// everything in here is derivable from events, so the tail keeps it fresh.

// The SDK session behind an active thread, as the session.* events of the
// log describe it — the fold lives in src/projections/session.ts, shared
// with the console's reducer.
import type { SessionState, SessionView } from '../projections/session.ts';

export type { SessionState, SessionView };

export type ProjectView = {
  id: string;
  title: string;
  slug: string;
  description: string;
  archived: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type TaskView = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  kind: string; // 'note' | 'code' | 'command'
  cron: string | null;
  at: Date | null;
  note: string | null;
  command: string | null;
  cwd: string | null;
  timeoutMs: number | null;
  reportOnSuccess: boolean;
  createdBy: string | null;
  createdAt: Date;
  // The next cron moment after now (config.scheduleTimezone), or the one-shot
  // `at`; null for a task without a trigger.
  nextRunAt: Date | null;
};

export type ConnectionView = {
  id: string;
  server: string;
  accountKey: string;
  displayName: string;
  status: string; // 'pending' | 'connected' | 'reauthorization_required'
  // The human-readable part of the provider identity (login/email), or null.
  identity: string | null;
  scope: string | null;
  threadId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

// A connectable service of the installation: the user-auth MCP servers of
// the config (mcp-servers/*.json with auth: "user").
export type ServiceView = {
  name: string;
  description: string | null;
  // Whether the service can hold several accounts per user (identity probe).
  multiAccount: boolean;
  // Whether an installation-level OAuth client must be provisioned by hand.
  manualClient: boolean;
};

export type AgentView = {
  name: string;
  description: string;
  icon: string | null;
  sdk: 'claude' | 'codex';
  tools: string[];
  agents: string[];
  headless: boolean;
  notification: string | null;
  model: string | null;
  effort: string | null;
};

export type SnapshotResponse = {
  // seq of the last event of the log at the moment of reading, taken BEFORE
  // the projections are read — the tail from here may overlap, never gap.
  asOfSeq: bigint;
  me: MeResponse;
  // The window: every active thread plus the newest 200 by createdSeq.
  threads: Thread[];
  sessions: Record<string, SessionView>;
  projects: ProjectView[];
  apps: AppsResponse;
  tasks: TaskView[];
  connections: ConnectionView[];
  services: ServiceView[];
  agents: AgentView[];
};
