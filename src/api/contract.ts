// Wire contract of the /api namespace. The console (src/console) imports
// these TYPE-ONLY: no runtime code crosses the process boundary. On the wire
// every body goes through serialize-json in both directions, so bigint and
// Date survive as their marked forms and these types describe the RESTORED
// values, not the raw JSON.

// Every error, any endpoint, one shape.
export type ApiErrorBody = {
  error: {
    code: string;
    message: string;
    // The files a message was refused for (400 file_not_accepted of
    // POST /api/threads/:id/messages): the composer marks their chips.
    fileIds?: string[];
  };
};

export type AuthRequest = {
  code: string;
};

// POST /api/auth/console-code: no body, no session; 204 with an empty body —
// the code goes to the server's stdout, never over the wire. 429 when one
// was printed moments ago.

// The workspace's name of Settings.
export type NamesView = {
  // The workspace's name: the stored one (Settings), else the bound Telegram
  // group's title when that channel is on; null otherwise.
  workspaceName: string | null;
};

// The user behind this browser's session (src/users): the one the code was
// issued to. The name is theirs across every workspace — the sidebar line
// under the workspace, "you" in the feed, the author of their messages in
// the agents' prompts; null while they have none (the Telegram profile
// fills it in, Settings sets it).
export type UserView = {
  userId: string;
  displayName: string | null;
};

export type MeResponse = NamesView & {
  workspaceId: string;
  // The workspace's main thread (the coordinator's root thread) — the
  // header's «to the coordinator» link target. Null only before activation.
  mainThreadId: string | null;
  user: UserView;
};

// PATCH /api/user: the user's own name. null, empty or blank — cleared
// (the channel's profile names them again, once it sees them); a string —
// trimmed, at most 100 chars, theirs from now on. 400 for another type or
// a longer name. Not an event of the log (the user spans workspaces): the
// answer updates `me` of the saving tab, another tab learns it with its
// next /api/me.
export type UserPatchRequest = {
  displayName?: string | null;
};

export type UserResponse = {
  user: UserView;
};

// POST /api/logout signs this browser out of the workspace the request acts
// in (not of the browser's other workspaces); the answer lists the ones
// still signed in, in the order they were signed in to — empty when that
// was the last one (the session and its cookie are gone with it).
export type LogoutResponse = {
  ok: true;
  signedIn: string[];
};

// PATCH /api/settings: a field absent — left alone; null, empty or blank —
// cleared (the workspace goes by the group's title again); a string —
// trimmed, at most 100 chars. 400 for another type or a longer name. The
// answer is the effective names, as /api/me reports them, and where the
// change stands in the log.
export type SettingsPatchRequest = {
  workspaceName?: string | null;
};

export type SettingsResponse = {
  settings: NamesView;
  // seq of the settings.updated event this call journaled — the names are
  // the row's as of it, so a tab takes them only ahead of the names its
  // tail already brought (a later save of another tab, answered sooner,
  // is not put back). Null when nothing changed (an empty patch).
  seq: bigint | null;
};

// Where the one-time code a web session was born from came from: the
// /auth_code command in the bound Telegram group, or the code the /login
// page had the server print into its log.
export type LoginSource = 'telegram' | 'console';

// GET /api/settings — the facts the Settings screen shows beside the names:
// none of them is an event of the log (the Telegram binding is a row the
// bot writes, the time zone is the server's configuration, the session is
// the request's own cookie), so the screen reads them by place, not from
// the snapshot.
export type TelegramGroupView = {
  chatId: bigint;
  // The group's title through the Bot API (cached ten minutes); null when
  // the channel is off or the call failed.
  title: string | null;
  // When the binding was last written: the /start that bound the group, or
  // the chat's migration to a supergroup after it.
  linkedAt: Date;
};

export type TelegramView = {
  // The channel is configured (a bot token): the bot posts and takes
  // messages. Off — a bound group is remembered but not served.
  enabled: boolean;
  // The bot's @username (without the @) through the Bot API, once per
  // process; null while the channel is off or the call failed.
  botUsername: string | null;
  // The group bound to this workspace, null while none is.
  group: TelegramGroupView | null;
};

export type WebSessionView = {
  // When this browser's session was born (the code exchange).
  createdAt: Date;
  // The User-Agent the browser sent at sign-in, as recorded ('' when it
  // sent none).
  userAgent: string;
  // How the code came — null for a session born before the fact was kept.
  loginSource: LoginSource | null;
};

// GET /api/workspaces — the workspaces this browser is signed in to (one
// session cookie, several workspaces; a request acts in the one it names by
// the X-Balabash-Workspace header or ?ws=, else in the session's primary
// one). Read by place: names of the other workspaces are not in the log of
// the one a tab shows.
export type SignedInWorkspaceView = NamesView & {
  workspaceId: string;
  // When this browser signed in to the workspace, and how the code came.
  signedInAt: Date;
  loginSource: LoginSource | null;
};

export type WorkspacesResponse = {
  // The workspace this request acted in.
  current: string;
  workspaces: SignedInWorkspaceView[];
};

export type SettingsFactsResponse = {
  telegram: TelegramView;
  // The IANA time zone the schedule evaluates cron expressions in
  // (SCHEDULE_TIMEZONE of the server's environment).
  scheduleTimezone: string;
  session: WebSessionView;
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
// session's workspaceId on the server. Newest first; `before` is the cursor —
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
  // The log position the counts are exact at (read together under one
  // snapshot of the database): a terminal with seq <= it is already in
  // them, one above is not — the client folds the tail accordingly.
  countsAsOfSeq?: bigint;
};

// GET /api/threads/:id — the thread as the snapshot and the list carry it
// (its `headless` included: a headless thread's chat is the read-only
// dialogue with the parent and POST /messages answers 409; its `remote`
// too: a remote agent's thread, the mirror of a session elsewhere).
export type ThreadResponse = {
  thread: Thread;
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
// A message is text, files or both: fileIds are stored files of the
// workspace (uploaded through POST /api/files), at most 20; one that is not
// the session's (foreign, missing) refuses the whole message — 400
// file_not_accepted naming them in error.fileIds. The event carries the
// files as every channel writes them: text (null without one), blocks and
// files (InboundFile).
//
// GET /api/files/:fileId streams a stored file of the workspace (the
// attachments of user/agent messages: payload.files[].fileId, content
// blocks' fileId) — inline, ?download=1 for an attachment; a foreign or
// missing id is the same 404.
export type PostThreadMessageRequest = {
  text?: string;
  fileIds?: string[];
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

// POST /api/threads/:id/finish — the thread is asked to wrap up
// (thread.finish): the agent writes its report and ends the thread itself;
// a remote agent's session is asked for a closing summary, which completes
// the thread. Any active child thread takes it, answered like the two
// above. The commands of a remote agent's thread alone (src/remote/engine.ts;
// 409 thread_not_remote for any other thread): POST
// /api/threads/:id/pause — the thread sleeps now (thread.pause); POST
// /api/threads/:id/decide — the operator's decision on an open question
// (agent.ask): the decision must be one of the question's options (400
// bad_request), a sign-in is completed by its link alone (400
// decision_by_link_only), a question not open answers 409 ask_not_open.
export type DecideThreadRequest = {
  askId: string;
  decision: string;
};

// ---------------------------------------------------------------------------
// The workspace file area: the user's window into
// data/workspace/<workspaceId>/files. GET /api/workspace/node?path=<rel> answers
// with a polymorphic node — a directory listing or one file's metadata — so
// a deep link learns what it points at in one request. Raw content streams
// from the root namespace instead: GET /files/<rel> (bytes + honest
// content-type, no JSON envelope — not described here). Inline by default,
// ?download=1 answers as an attachment. The one write of the area is PUT
// /files/<rel> (below, WorkspaceWriteResponse).

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

// A folder of a listing: its own modification time (a direct entry added,
// removed or renamed — the files inside changing do not move it) and the
// count of its direct children by the listing's rule (directories and
// regular files). Two independent reads, each null on its own: modifiedAt
// when the folder could not be stat'ed, both counts when it could not be
// read into (unknown counts, the date kept); a folder that vanished between
// the listing and its reads is all null.
export type WorkspaceFolderMeta = {
  path: string;
  modifiedAt: string | null; // ISO date-time
  directoryCount: number | null;
  fileCount: number | null;
};

export type WorkspaceNodeResponse =
  | {
      kind: 'dir';
      // '' is the file-area root; a missing root answers as an empty dir.
      path: string;
      // The names of the folders, in order; folders carries the same
      // entries with their facts (a listing without folders is read by its
      // names alone — src/console/features/file-area/node.ts).
      directories: string[];
      folders: WorkspaceFolderMeta[];
      files: WorkspaceFileMeta[];
    }
  | {
      kind: 'file';
      path: string;
      file: WorkspaceFileMeta;
    };

// PUT /files/<rel> replaces the whole content of an existing Markdown file
// with the request body (raw UTF-8 text, the console's editor). Markdown
// only (400 `not_editable` for anything else), a missing path or a folder
// is the GET's 404, a body over the editor's limit a 413 `too_large`. The
// request may carry If-Match with the ETag the GET answered: 412
// `precondition_failed` when the file changed since that read, so an
// agent's write is never overwritten unseen; without If-Match the content
// is replaced whatever is there. The answer is the file's node as the
// listing reads it and the ETag of the new content (also the ETag header).
export type WorkspaceWriteResponse = {
  file: WorkspaceFileMeta;
  etag: string;
};

// POST /files/<rel>[?conflict=replace|keep] creates a file of the area from
// the request body (the bytes of one file, any type, up to 2 GB — 413
// too_large). The folder must exist (404 otherwise). A taken name is a 409
// `exists` unless the request answers the clash: replace — the new bytes
// take the name (a folder or a link under it is not replaced: 409
// not_a_file); keep — the first free "name (n).ext". A full volume is a 507
// no_space. The answer (201) is the file's node as placed: its path is the
// name the file got. No event is written.
export type WorkspaceUploadResponse = {
  file: WorkspaceFileMeta;
};

// ---------------------------------------------------------------------------
// A stored file's facts by id: GET /api/files/:fileId/meta, under the
// session with the ownership rule of the bytes (GET /api/files/:fileId) — a
// foreign file and a missing one are the same 404. For the attachments of
// recorded history that carry the fileId alone (src/core/file-blocks.ts);
// a stored file is immutable, so the answer is kept privately like the bytes.

export type StoredFileMeta = {
  fileId: string;
  // The original filename, null when the file arrived without one.
  name: string | null;
  contentType: string | null;
  sizeBytes: number | null;
  // Of an image, when known at ingest.
  width: number | null;
  height: number | null;
};

export type FileMetaResponse = { file: StoredFileMeta };

// POST /api/files: an attachment of the composer — the request body is the
// bytes of one file, its name in X-Balabash-Filename (percent-encoded), its
// type in Content-Type, its length declared (411 length_required without
// one), up to 2 GB (413 too_large); a full volume is a 507 no_space. The
// answer (201) is the stored file's facts: uploaded, ready to be named by a
// message's fileIds. A request cut off midway stores nothing.
export type UploadFileResponse = { file: StoredFileMeta };

// ---------------------------------------------------------------------------
// LLM request telemetry (read-only): the llm_requests table minus rawUsage,
// scoped to the session's workspaceId. Serves the /llm-usage chart — the raw
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
  // The request's number within the turn's inner loop (1..N).
  iteration: number | null;
  // 'turn' — a model turn (1..N requests), 'keepalive' — a prompt-cache
  // prewarm ping (one request, no output); null on rows from before the
  // column existed — read as 'turn'.
  purpose: string | null;
  // The server's prompt-cache verdict against the thread's previous request:
  // 'cache_hit' | 'cache_miss' | 'comparison_response_not_found' |
  // 'unavailable'; null when the request asked for none. The reason comes
  // with a miss only.
  cacheDiagnostic: string | null;
  cacheMissReason: string | null;
  cacheMissedTokens: number | null;
  // The response status, or 'request_failed' when the call threw — such a
  // row has no token counts (null, not zero).
  status: string;
  error: string | null;
  serviceTier: string | null;
  durationMs: number | null;
  inputTokens: number | null;
  // Parts of the input: read from the prompt cache, written to it; the rest
  // of the input went uncached.
  cachedTokens: number | null;
  cacheWriteTokens: number | null;
  outputTokens: number | null;
  // Part of the output spent on reasoning; the rest is text and tool calls.
  reasoningTokens: number | null;
  totalTokens: number | null;
};

// GET /api/llm-requests?limit=N&threadId=… — the newest N rows (of one
// thread when threadId is given; the console's "Main thread · tokens per
// request" reads the main thread's window this way), returned oldest-first
// so the client draws left to right without re-sorting.
export type LlmRequestsQuery = {
  threadId?: string;
  limit?: number;
};

export type LlmRequestsResponse = {
  requests: LlmRequestItem[];
};

// ---------------------------------------------------------------------------
// Plan limits (read-only, the second data layer): the rate-limit windows of
// the subscriptions the agents run on, measured in the process and kept in
// its memory — the newest measurement of each. Nothing here is an event of
// the log; the console reads it by place. Claude: the inner CLI of a live
// Claude session reads the claude.ai usage endpoint (the SDK control
// `get_usage`). Codex: a short-lived app-server of the vendored CLI answers
// `account/rateLimits/read` for the account in the app's CODEX_HOME. Both
// accounts are the host's logins: one per process, so a measurement is not
// scoped to a thread or a user.

export type LimitWindowKind = 'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet' | 'seven_day_oauth_apps' | 'model';

// How the API answered the last request against this window, as the
// session's rate_limit_event reported it: a warning or a refusal shows
// before the next measurement moves the percentage.
export type LimitWindowStatus = 'allowed' | 'allowed_warning' | 'rejected';

export type LimitWindowView = {
  kind: LimitWindowKind;
  // The server's label of a per-model weekly window ("Fable", "Opus"); null
  // for the plan-wide kinds.
  model: string | null;
  // Percent of the window used, 0–100; null when the endpoint did not say.
  utilization: number | null;
  resetsAt: Date | null;
  status: LimitWindowStatus | null;
};

// Extra usage past the plan (billed at API rates): whether the account has
// it on, whether the last requests went through it, the month's spend.
export type LimitOverageView = {
  enabled: boolean;
  inUse: boolean;
  usedCredits: number | null;
  monthlyLimit: number | null;
  utilization: number | null;
  currency: string | null;
};

export type ClaudeLimitsView = {
  // When the measurement was taken (the usage control answered).
  measuredAt: Date;
  // 'pro', 'max', 'team', 'enterprise' — or null for an API key / provider.
  subscriptionType: string | null;
  // False when plan limits do not apply to the account (API key, Bedrock,
  // Vertex): no windows then.
  available: boolean;
  windows: LimitWindowView[];
  overage: LimitOverageView | null;
};

// The last round of measuring that brought nothing: when, and what the
// source said (Claude: the SDK marks the control experimental — a CLI may
// refuse it in its context, a control may not answer in time; Codex: the
// app-server's error, a process that exited, no answer in time). Cleared
// by a measurement.
export type LimitFailureView = {
  at: Date;
  message: string;
};

// The Claude half of GET /api/limits: limits — the newest measurement, or
// null when none was taken since the process started (the limits are
// measured through a live Claude session: none has run, or the control
// failed in every one); lastFailure — the outcome of the last round since
// that measurement that brought none, null when the last round measured.
// liveSessions — the Claude sessions alive right now (zero explains a stale
// measurement: nothing can refresh it until the next run); lastSessionAt —
// when the last Claude session ended, null when none has since the process
// started.
export type ClaudeLimitsResponse = {
  limits: ClaudeLimitsView | null;
  lastFailure: LimitFailureView | null;
  liveSessions: number;
  lastSessionAt: Date | null;
};

// One rate-limit window of the Codex account: the backend meters a primary
// window and, on some plans, a secondary one, each of a stated length
// (minutes; 10080 — a week, 300 — five hours) with the percent used and
// the reset moment. bucket — the backend's limit the window belongs to
// (its name, or its id) when it meters more than one; null for the one
// bucket of the plan.
export type CodexLimitWindowView = {
  bucket: string | null;
  kind: 'primary' | 'secondary';
  windowMinutes: number | null;
  utilization: number;
  resetsAt: Date | null;
};

// The member's own spend limit of the period, when the plan has one: the
// used and the limit as the backend prints them, the percent left, the
// reset moment (null when the backend's moment is not a date).
export type CodexSpendLimitView = { used: string; limit: string; remainingPercent: number; resetsAt: Date | null };

// What the backend states of one metered limit beside its windows — the
// facts are the bucket's, not the account's: on a plan that meters several
// limits one may be refusing while another goes through. bucket — as on
// the windows (null for the one bucket of the plan).
export type CodexBucketView = {
  bucket: string | null;
  // Why the backend is refusing requests against this limit, when it is
  // ('rate_limit_reached', 'workspace_owner_credits_depleted', …); null
  // while they go through.
  reached: string | null;
  // The workspace's spend control is reached (null — the backend did not
  // say).
  spendControlReached: boolean | null;
  spendLimit: CodexSpendLimitView | null;
};

export type CodexLimitsView = {
  measuredAt: Date;
  // The backend's plan type ('plus', 'pro', 'prolite', 'team', 'business',
  // 'enterprise', 'free', …), null when it did not say.
  planType: string | null;
  windows: CodexLimitWindowView[];
  // Every metered limit, in the windows' order — the keyed snapshots when
  // the backend sent them, else the historical one.
  buckets: CodexBucketView[];
  // Extra credits of the account: whether it has any, whether they are
  // unlimited, the balance as the backend prints it; null when not said.
  credits: { has: boolean; unlimited: boolean; balance: string | null } | null;
  // Rate-limit reset credits the account can redeem (the backend's "full
  // reset" grants), null when not said.
  resetCredits: number | null;
};

// The Codex half of GET /api/limits: limits — the newest measurement, or
// null when none has succeeded since the process started (a read measures
// when the cache is stale, so null means the app-server has not answered
// yet, or answered nothing but failures); lastFailure — as for Claude;
// signedOut — the CLI has no login to read the limits with (the last round
// that told anything about the login was refused for it; a measurement
// clears it): the console then shows no Codex group at all.
export type CodexLimitsResponse = {
  limits: CodexLimitsView | null;
  lastFailure: LimitFailureView | null;
  signedOut: boolean;
};

// GET /api/limits — both accounts' newest measurements.
export type LimitsResponse = {
  claude: ClaudeLimitsResponse;
  codex: CodexLimitsResponse;
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
  // The owner page of the app, https://<CONSOLE_DOMAIN>/apps/<path>
  // (ownerAppUrl of src/apps/urls.ts): only the signed-in owner, published
  // or not. Absent in the listing of an older server.
  ownerUrl?: string;
};

export type AppsResponse = {
  apps: AppListingView[];
  // Absolute base of public app URLs, no trailing slash (src/apps/urls.ts):
  // https://<APPS_DOMAIN> with an apps domain, https://<CONSOLE_DOMAIN>/a
  // without one — the client builds <publicAppsBase>/<slug>.
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
  // When it was archived ("Archived since Oct 2"); null on a live project
  // and on one archived before the date was kept — such a project reads
  // as archived without a date.
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

// ---------------------------------------------------------------------------
// The project registry under the session (stage 6b): POST /api/projects
// creates a project (the row plus its folder <slug>/ in the workspace file
// area — an existing folder is adopted, `adopted: true`); PATCH
// /api/projects/:id changes the title, the description and/or the slug (a
// slug change renames the folder in step; an empty body is a "touch" —
// updatedAt bumps, nothing else changes); POST /api/projects/:id/archive and
// /unarchive flip the flag (already in that state — the row as is, no event).
// Every change journals its project.* event in the row's transaction
// (actor user, no thread), so the console learns of it through the stream.
// 400 bad_request (a body that is not a JSON object or not valid JSON, a
// field of another type, a blank title or description on create, a slug
// outside /^[a-z][a-z0-9-]*$/ or over 64 chars, a title over 200 or a
// description over 2 000 chars; in a PATCH a blank or null field keeps the
// current value), 404 not_found (a foreign or missing project), 409
// conflict (the title, the slug or the folder path is taken; archived
// projects keep theirs). Same rules as the projects_* tools of the agents —
// one implementation (src/projects/mutations.ts).

export type CreateProjectRequest = {
  title: string;
  slug: string;
  description: string;
};

export type UpdateProjectRequest = {
  title?: string | null;
  description?: string | null;
  slug?: string | null;
};

export type ProjectResponse = {
  project: ProjectView;
};

export type CreateProjectResponse = ProjectResponse & {
  // The folder already existed in the file area and became the library.
  adopted: boolean;
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

// ---------------------------------------------------------------------------
// The schedule's run journal and the operator's commands over a task (the
// Schedule screen). A run is a row of job_runs — the journal of workspace
// jobs (kind 'command'): every run of one is written, a success as well as
// a failure; a note task leaves a schedule.fired event instead, a code task
// only what it pushes. The journal is telemetry outside the event log (the
// llm_requests pattern), so the console reads it by place.

export type JobRunStatus = 'running' | 'ok' | 'failed' | 'timeout' | 'spawn_error' | 'aborted';
export type JobTrigger = 'cron' | 'at' | 'manual';

// One run as the lists show it: the outcome and the timing, without the
// output tails (a page of runs stays small).
export type JobRunView = {
  id: string;
  slug: string;
  trigger: JobTrigger;
  status: JobRunStatus;
  exitCode: number | null;
  startedAt: Date;
  finishedAt: Date | null;
  durationMs: number | null;
  // Whether the kept tail of a stream lost its beginning (16 KiB kept).
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
};

// One run in full: the command and working directory as they were at fire
// time (the task may be gone or changed since) and the tails of both streams.
export type JobRunDetailView = JobRunView & {
  command: string;
  cwd: string | null;
  stdoutTail: string;
  stderrTail: string;
};

export type JobRunsQuery = {
  // Only the runs of this task.
  slug?: string;
  // Cursor: the id of the oldest run of the previous page — the next page
  // holds the runs started before it.
  before?: string;
  limit?: number;
};

// Newest first; nextCursor — the id to ask `before` for the next page, null
// at the end.
export type JobRunsResponse = {
  runs: JobRunView[];
  nextCursor: string | null;
};

// The newest run of every task that has one (by slug): the "last run" of
// the task rows.
export type LatestJobRunsResponse = {
  runs: JobRunView[];
};

export type JobRunResponse = {
  run: JobRunDetailView;
};

// The row a command over a task means — the task the operator saw and
// confirmed. Absent: whatever row holds the slug. Present and the slug now
// held by another row (the task cancelled and created again under the same
// slug): 409 task_replaced, nothing fired or deleted. POST …/run reads it
// from the body, DELETE from the query (`?taskId=`).
export type TaskCommandRequest = {
  taskId?: string;
};

// POST /schedule/tasks — a task registered from the console, by the rules of
// the create_task tool (src/schedule/input.ts, one parser for both doors):
// the slug's shape, a name, at most one trigger — a cron expression
// (evaluated in the schedule's time zone) or `at`, an ISO 8601 instant with
// an explicit offset — a note for kind 'note', the command fields for kind
// 'command' only (cwd relative to the file area, timeoutMs 1 s – 5 h, null
// for the default 10 min). null and absent are one "not given". The
// answer is the row as the snapshot has it (the same row arrives as
// schedule.task.created of the tail, folded idempotently) and whether a
// code task sleeps (no run(ctx) body yet). Refusals: 400 bad_request (the
// message starts with the field at fault), 409 task_conflict (the slug is
// taken — by any workspace: slugs are global to the registry).
export type CreateTaskRequest = {
  slug: string;
  name: string;
  description?: string | null;
  kind: 'note' | 'code' | 'command';
  cron?: string | null;
  at?: string | null;
  note?: string | null;
  command?: string | null;
  cwd?: string | null;
  timeoutMs?: number | null;
  reportOnSuccess?: boolean | null;
};

export type CreateTaskResponse = {
  task: TaskView;
  sleeping: boolean;
};

// POST /schedule/tasks/:slug/run — the task fired by hand, the schedule
// untouched: `fired` with the runId of a command job (null for a note or a
// code task — they leave no journal row), or `already_running` when a run of
// the same task is still going and this one burns.
export type RunTaskResponse = {
  outcome: 'fired' | 'already_running';
  runId: string | null;
};

// DELETE /schedule/tasks/:slug — the row as it was; the same end arrives as
// schedule.task.cancelled of the tail.
export type DeleteTaskResponse = {
  task: TaskView;
};

// The operator's commands over the connections (the Connections screen),
// the same implementation the auth agent's tools use
// (src/capabilities/connections/index.ts). PATCH /connections/:id — the
// account's name in Balabash (the address and the provider identity never
// change); DELETE /connections/:id — the account is disconnected: the row
// and its tokens are gone, access on the provider's side is revoked in the
// provider's own settings. The answer is the row as the snapshot has it
// (the row as it was, for a delete); the same change arrives as
// connection.renamed / connection.disconnected of the tail.
export type RenameConnectionRequest = {
  name: string;
};

export type ConnectionResponse = {
  connection: ConnectionView;
};

// POST /connections — a one-time sign-in link for a new account of a service
// of the catalog: without a name the service's first account (refused once
// it has one), with a name a new account named so (its address derived from
// the name; a name in use is refused). POST /connections/:id/reconnect — the
// link for an existing account (re-authorization). Both answer the link,
// the row it belongs to (pending when new, otherwise as it was — a
// connected account stays connected until the new flow completes) and the
// moment the link expires; the link itself is never in the log. The flow's
// events are addressed to the main thread.
export type StartConnectionRequest = {
  server: string;
  name?: string;
};

export type ConnectLinkResponse = {
  connection: ConnectionView;
  url: string;
  expiresAt: Date;
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

// An open request for installation credentials (the one-time link an agent
// sent the operator, src/capabilities/secret-requests.ts): what the bell
// shows until the values land. Field names only, never values.
export type OpenSecretRequestView = {
  id: string;
  kind: 'external-secrets' | 'oauth-client';
  server: string;
  fields: string[];
  // The thread that issued the link and its agent; null when the row
  // predates the thread being kept or the thread is gone.
  threadId: string | null;
  agent: string | null;
  // When the link was issued; a request issued again for the same server
  // replaces the open one and carries the new moment.
  requestedAt: Date;
};

// A connectable service of the installation: the user-auth MCP servers of
// the config (mcp-servers/*.json with auth: "user").
export type ServiceView = {
  name: string;
  description: string | null;
  // Whether the service can hold several accounts per workspace (identity probe).
  multiAccount: boolean;
  // Whether an installation-level OAuth client must be provisioned by hand.
  manualClient: boolean;
};

// A service of the installation: an external MCP server whose credentials
// are the installation's (${secret:NAME} in its config) — one set for every
// workspace, provisioned through the secrets form, forgotten for everyone.
// state: connected; missing — a credential is not provisioned; failed —
// provisioned, but the last connection attempt failed (error says why).
export type InstallationServiceView = {
  name: string;
  description: string | null;
  secretNames: string[];
  state: 'connected' | 'missing' | 'failed';
  error: string | null;
};

// A claude.ai connector of the installation (transport "claude-connector"
// in mcp-servers): the provider's authorization lives in the operator's
// claude.ai account, the proxy takes the operator's ambient Claude CLI
// token — nothing to provide or forget here, the catalog shows it
// read-only. state: connected; token_expired — connected, but the ambient
// token on this box has expired (calls fail until a Claude Code session
// rotates it; tokenExpiresAt says since when); failed — the connection
// itself failed (error says why, retried on the next look).
export type ConnectorServiceView = {
  name: string;
  description: string | null;
  state: 'connected' | 'token_expired' | 'failed';
  error: string | null;
  tokenExpiresAt: Date | null;
};

// GET /api/installation-services — the second data layer: the states live
// in the process's memory, read after a reconnect attempt where one is due.
// connectors is absent in the answer of a build that predates it.
export type InstallationServicesResponse = { services: InstallationServiceView[]; connectors?: ConnectorServiceView[] };

// POST /api/installation-services/:name/secret-request — the request the
// secrets form at /secrets/<requestId> fulfils (addressed to the main
// thread; a request open for the server is replaced, its link kept).
export type InstallationSecretRequestResponse = { requestId: string };

// DELETE /api/installation-services/:name/secrets — the credentials
// deleted (how many values) and the server disconnected for everyone.
export type ForgetInstallationSecretsResponse = { server: string; forgotten: number };

// An agent of the catalog as the console shows it, plus the coordinator —
// the secretary of the main thread, which is not a catalog module: its
// engine is the OpenAI backend, its tools are the tool servers of its own
// passport (src/coordinator/functions.ts), it launches every catalog agent.
export type AgentView = {
  name: string;
  description: string;
  icon: string | null;
  // 'remote' — a remote agent kind of the installation (src/remote): the
  // session runs in an external system; no tools, no model of ours.
  sdk: 'claude' | 'codex' | 'openai' | 'remote';
  // The tool servers of the passport as it acts (not the single tools): the
  // names it lists plus the extension servers "projects" brings.
  tools: string[];
  agents: string[];
  headless: boolean;
  notification: string | null;
  // The model the declaration names; null leaves the choice to the engine.
  model: string | null;
  // The reasoning effort the declaration names; null means defaultEffort.
  effort: string | null;
  // The effort a session runs with when the declaration names none — the
  // platform's own default for the Claude and Codex sessions; null for the
  // coordinator (its requests name no effort).
  defaultEffort: string | null;
  // The model the agent's newest session actually started with (the model
  // of its latest session.started in this workspace) — what the engine's
  // default resolves to, and whether a named model is what runs; null while
  // no session of the agent journaled one (Codex sessions and the
  // coordinator never do).
  lastModel: string | null;
};

// --------------------------------------------------------------------------
// GET /api/system — the machine, the process and what runs in it: a
// measurement of the moment (src/api/system.ts), never an event of the log.
// What the host does not offer is null.

export type MachineView = {
  uptimeSeconds: number;
  cpu: {
    cores: number;
    // The busy share of each core, in percent, over the span since the
    // sample before; null until two samples are apart enough to say.
    perCore: number[] | null;
    loadAvg: [number, number, number];
  };
  memory: { totalBytes: number; usedBytes: number; swapTotalBytes: number; swapUsedBytes: number } | null;
  // The volume the process runs on (data/ — the workspaces' file areas —
  // is under its working directory).
  disk: { totalBytes: number; usedBytes: number; freeBytes: number } | null;
  network: {
    inBytesPerSecond: number | null;
    outBytesPerSecond: number | null;
    // The bytes received per minute over the last hour, oldest first — as
    // many minutes as the process has seen; a minute the kernel could not
    // be read in, or a late sample, holds the average of its gap.
    inboundPerMinute: number[];
  } | null;
};

export type ProcessVersionView = {
  // The build the process runs, stamped into the bundle when it was built
  // (build/server.js): the short hash of the checkout's HEAD the build read
  // and its branch, whether the tree held uncommitted changes then (the
  // bundle is not that commit alone), and the moment of the build. Null
  // where the build ran outside a git checkout, or the code runs unbundled.
  commit: string | null;
  branch: string | null;
  dirty: boolean;
  builtAt: Date | null;
  // The checkout the process was started in (git rev-parse at start): the
  // same commit as the build's unless the supervisor rolled the bundle back
  // or the checkout moved without a build — then both are shown. Null
  // outside a git checkout, or when git is not there.
  checkout: { commit: string; branch: string | null } | null;
};

export type ProcessView = ProcessVersionView & {
  pid: number;
  node: string;
  startedAt: Date;
  uptimeSeconds: number;
  rssBytes: number;
  heapUsedBytes: number;
  // The runs alive in the process — the live agent sessions of every
  // workspace, the coordinator's among them — and the workspace jobs of
  // the schedule in flight.
  liveSessions: number;
  workspaceJobs: number;
};

export type DatabaseView = {
  // The size read answered — the database is reachable.
  available: boolean;
  sizeBytes: number | null;
  error: string | null;
  // Whether the connection string names this host (loopback or a socket):
  // a remote database takes no room on the volume the disk meter shows.
  local: boolean;
};

// The file storage of the installation (src/files/storage.ts), one for
// the host whatever the workspace: the driver and the bytes of every
// stored file as the files table says them — the local driver keeps them
// under FILES_ROOT, the spaces driver off this host.
export type FileStorageView = {
  kind: 'local' | 'spaces';
  bytes: number | null;
};

// The totals of the workspace's file area, as the newest walk counted them
// (src/workspace/totals.ts): every regular file on disk; `folders` — the
// same per top-level folder (a project's folder among them). An incomplete
// walk — cut at its cap, or with folders and files it could not read — is
// a lower bound: the area holds at least this much.
export type FileAreaTotalsView = {
  measuredAt: Date;
  files: number;
  bytes: number;
  folders: Record<string, { files: number; bytes: number }>;
  // False when the walk could not count everything: the totals are at
  // least what they say.
  complete: boolean;
  // The folders and files the walk could not read (a permission refused, an
  // I/O error) — not counted, and the measurement incomplete for them.
  unreadable: number;
};

// The restart in the way, as this workspace may see it: the request's own
// words (reason, requester, thread) only when the request came from this
// workspace (`own`); another workspace's request is a bare fact — that a
// restart is pending since when, and whether it is forced (a forced
// restart cancels every workspace's threads). What it waits for names the
// threads of this workspace and counts the others.
export type PendingRestartView = {
  // The seq of the system.restart.requested event — a completion of the log
  // with a greater seq means this view is stale.
  seq: number;
  own: boolean;
  reason: string | null;
  requestedAt: Date;
  requestedBy: string | null;
  threadId: string | null;
  force: boolean;
  // What the newest poll of the safe window found in the way; null before
  // the first poll.
  waiting: {
    threads: { id: string; title: string | null; agent: string }[];
    // Active threads of other workspaces in the way — a count, not names.
    otherThreads: number;
    secretaryTurn: boolean;
    workspaceJob: boolean;
    logQuiet: boolean;
  } | null;
};

// GET /api/system/log?kind=restart|exception&before=<seq>&limit=N — the
// system's own events as the snapshot's systemLog shows them (this
// workspace's and the installation's), for the "Show more" of the System
// screen's Restarts and System event log cards: the newest N older than
// `before` (every one without it), in seq order, and the count of every
// such event. kind — restarts (requested and completed) or exceptions;
// none — all three.
export type SystemLogKind = 'restart' | 'exception';

export type SystemLogQuery = {
  kind?: SystemLogKind;
  // A seq; only events before it.
  before?: string;
  limit?: number;
};

export type SystemLogResponse = {
  events: Event[];
  total: number;
};

export type SystemResponse = {
  at: Date;
  machine: MachineView;
  process: ProcessView;
  database: DatabaseView;
  fileStorage: FileStorageView;
  // Null before the first walk of the file area.
  fileArea: FileAreaTotalsView | null;
  restart: { pending: PendingRestartView | null };
};

export type SnapshotResponse = {
  // seq of the last event of the log at the moment of reading, taken BEFORE
  // the projections are read — the tail from here may overlap, never gap.
  asOfSeq: bigint;
  me: MeResponse;
  // The window: every active thread, the newest 200 by createdSeq, the
  // main thread and the thread that ended last (the greatest terminalSeq).
  threads: Thread[];
  // The newest user.message or agent.message the main thread's feed shows
  // (authored in it or addressed to it), for its pinned row before any of
  // its events are loaded; null while it has none.
  mainLastMessage: Event | null;
  sessions: Record<string, SessionView>;
  projects: ProjectView[];
  apps: AppsResponse;
  tasks: TaskView[];
  connections: ConnectionView[];
  services: ServiceView[];
  // The open requests for installation credentials, oldest first.
  secretRequests: OpenSecretRequestView[];
  agents: AgentView[];
  // The newest system events (restarts requested and completed,
  // exceptions — this workspace's and the installation's; SYSTEM_LOG_KEEP
  // of src/api/snapshot.ts), in seq order; the tail keeps them (store/system).
  systemLog: Event[];
};
