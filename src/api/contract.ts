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

export type MeResponse = {
  userId: string;
  // Title of the bound telegram group — the human-readable workspace name.
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
  Event,
  EventActor,
  JsonObject,
  JsonValue,
  Thread,
  ThreadStatus,
  ThreadSummary,
} from '../core/contract.ts';

import type { Event, Thread, ThreadStatus } from '../core/contract.ts';

// GET /api/threads query: everything optional, everything scoped to the
// session's userId on the server. Newest first; `before` is the cursor —
// the nextCursor of the previous page (a thread's createdSeq, decimal).
export type ThreadsQuery = {
  status?: ThreadStatus;
  // A thread id, or the literal "null" for root threads.
  parentId?: string;
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
};

export type ThreadResponse = {
  thread: Thread;
};

// GET /api/threads/:id/events: newest first, cursor-paginated by the global
// event seq — pass the previous page's nextCursor as ?before= to continue
// into older events. seq is unique and follows insert order, so events
// sharing a createdAt timestamp still page deterministically.
export type ThreadEventsResponse = {
  events: Event[];
  // seq of the last (oldest) returned event when the page came back full —
  // pass it as ?before= to continue; null = the feed is exhausted.
  nextCursor: bigint | null;
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
