// The /api namespace: JSON over the session, the second interface's server
// side. The userId comes ONLY from the session — no endpoint accepts it from
// the request. Bodies cross the wire through serialize-json in both
// directions (bigint/Date survive), errors share one shape
// ({error: {code, message}}), and an unmatched /api path answers JSON 404
// instead of falling through to other middleware.

import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import Router from '@koa/router';
import { Api } from 'grammy';
import type { Context, Next } from 'koa';
import { prisma } from '../db/client.ts';
import { config } from '../config/index.ts';
import { parseJson, prepareObject } from '../utils/serialize-json.ts';
import { countThreadsAt, ensureOperatorWorkspace, getMainThread, getThread, isHeadlessThread, listThreads } from '../core/threads.ts';
import { getEventsAfter, listThreadEvents } from '../core/events.ts';
import { getLiveHub } from '../core/live.ts';
import { appendEvent } from '../core/append.ts';
import { THREAD_CANCEL, THREAD_INTERRUPT } from '../core/envelope.ts';
import type { FileRef, Thread, ThreadStatus } from '../core/contract.ts';
import { WorkspacePathError, listDir, resolveFilePath, sanitizeRelPath, statFile } from '../workspace/files.ts';
import { getFile, getUserFile, openFileContent } from '../files/index.ts';
import { verifyDownloadLink } from '../files/storage/local.ts';
import { getExternalServerSecretRequest, provisionExternalServerSecrets } from '../capabilities/external-secrets.ts';
import { getOauthClientRequest, provisionOauthClient } from '../capabilities/connections/index.ts';
import { AppManagementError, listApps, publishApp, unpublishApp } from '../apps/management.ts';
import { ProjectError, archiveProject, createProject, parseProjectInput, parseProjectPatch, unarchiveProject, updateProject } from '../projects/mutations.ts';
import { projectView } from '../projects/store.ts';
import { publicAppsBase } from '../apps/urls.ts';
import { consumeAuthCode, createAuthCode } from './auth-codes.ts';
import { createUserSession, destroySession, getSession } from './session.ts';
import { createEventStreamHandler } from './event-stream.ts';
import { buildSnapshot } from './snapshot.ts';
import { checkMutationOrigin } from './origin.ts';
import type {
  AppsResponse,
  CreateProjectResponse,
  ProjectResponse,
  PublicationResponse,
  LlmRequestsResponse,
  LogoutResponse,
  MeResponse,
  PostThreadMessageResponse,
  ThreadCommandResponse,
  ProvisionSecretsResponse,
  SecretRequestResponse,
  SecretRequestView,
  ThreadEventsResponse,
  ThreadResponse,
  ThreadsResponse,
  WorkspaceNodeResponse,
} from './contract.ts';

function sendError(ctx: Context, status: number, code: string, message: string): void {
  ctx.status = status;
  ctx.body = prepareObject({ error: { code, message } });
}

async function readJsonBody(ctx: Context): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];

  for await (const chunk of ctx.req) {
    chunks.push(chunk as Buffer);
  }

  try {
    const raw = Buffer.concat(chunks).toString('utf8');
    const parsed = raw ? parseJson(raw) : {};

    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }

    return {};
  } catch {
    return {};
  }
}

// Session gate for every endpoint except the code exchange itself. The
// session row always carries a userId (anonymous sessions are never
// created), but the column is nullable — the guard re-checks.
async function requireSession(ctx: Context, next: Next): Promise<void> {
  const session = await getSession(ctx);

  if (!session || !session.userId) {
    sendError(ctx, 401, 'unauthorized', 'No valid session');

    return;
  }

  ctx.state.session = session;
  ctx.state.userId = session.userId;
  await next();
}

// The workspace name for /api/me is the bound telegram group's title: the
// User row itself is empty by design. Fetched via the Bot API and cached —
// a failure degrades to null, never to an error. Telegram is an optional
// channel: without it there is no group and the name is null; the Bot API
// client is created lazily so a boot without the token never touches it.
let telegramApi: Api | null = null;
const workspaceNameCache = new Map<string, { name: string | null; fetchedAt: number }>();
const WORKSPACE_NAME_TTL_MS = 10 * 60 * 1000;

async function getWorkspaceName(userId: string): Promise<string | null> {
  if (!config.telegramEnabled) {
    return null;
  }

  const cached = workspaceNameCache.get(userId);

  if (cached && Date.now() - cached.fetchedAt < WORKSPACE_NAME_TTL_MS) {
    return cached.name;
  }

  let name: string | null = null;

  try {
    const group = await prisma.telegramGroup.findUnique({ where: { userId } });

    if (group) {
      telegramApi ??= new Api(config.telegramBotToken);

      const chat = await telegramApi.getChat(Number(group.chatId));

      name = chat.title ?? null;
    }
  } catch {
    name = null;
  }

  workspaceNameCache.set(userId, { name, fetchedAt: Date.now() });

  return name;
}

// --------------------------------------------------------------------------
// Query-parameter parsing for the window endpoints. Everything is optional;
// anything present but malformed is a 400, not a silent default.

const THREAD_STATUSES: ThreadStatus[] = ['active', 'completed', 'failed', 'cancelled'];
// The longest agent name or search text GET /threads accepts.
const THREAD_FILTER_MAX = 200;
const LIST_LIMIT_DEFAULT = 100;
const LIST_LIMIT_MAX = 500;

function queryValue(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

// undefined = absent, null = present but unparseable.
function parseDateParam(value: string | undefined): Date | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? null : date;
}

// null = present but unparseable / out of range.
function parseLimitParam(value: string | undefined): number | null {
  if (value === undefined) {
    return LIST_LIMIT_DEFAULT;
  }

  if (!/^\d+$/.test(value)) {
    return null;
  }

  const limit = Number(value);

  return limit >= 1 && limit <= LIST_LIMIT_MAX ? limit : null;
}

// The ownership boundary of the workspace window lives HERE, on the API
// edge: the core facades (getThread, listThreadEvents) deliberately do not
// check it. A thread of another workspace and a missing thread answer
// identically — 404, no existence oracle.
async function requireOwnThread(ctx: Context, id: string): Promise<Thread | null> {
  const thread = await getThread(id);

  if (!thread || thread.userId !== ctx.state.userId) {
    sendError(ctx, 404, 'not_found', 'No such thread');

    return null;
  }

  return thread;
}

const router = new Router({ prefix: '/api' });

// The login code without any channel: the /login page asks for one (the
// user types the word "console" into the code field), the server mints it
// for the operator's workspace and prints it to its own stdout — the
// operator reads it from the process log (ssh, the supervisor's terminal).
// The response carries nothing: anyone who can reach the page may press the
// button, only whoever can read the log learns the code, and an extra
// request merely rotates it (one active code per user). The throttle keeps
// a stranger from flooding the log.
const CONSOLE_CODE_MIN_INTERVAL_MS = 10 * 1000;
let lastConsoleCodeAt = 0;

router.post('/auth/console-code', async ctx => {
  const now = Date.now();

  if (now - lastConsoleCodeAt < CONSOLE_CODE_MIN_INTERVAL_MS) {
    ctx.set('retry-after', String(Math.ceil((CONSOLE_CODE_MIN_INTERVAL_MS - (now - lastConsoleCodeAt)) / 1000)));
    sendError(ctx, 429, 'rate_limited', 'A login code was printed moments ago — look at the server log');

    return;
  }

  lastConsoleCodeAt = now;

  const mainThread = await ensureOperatorWorkspace();
  const code = createAuthCode(mainThread.userId);

  console.log(`[web] login code for the operator workspace (one-time, valid 10 minutes): ${code}`);

  ctx.status = 204;
});

router.post('/auth', async ctx => {
  const body = await readJsonBody(ctx);
  const code = typeof body.code === 'string' ? body.code : '';
  const userId = code ? consumeAuthCode(code) : null;

  if (!userId) {
    sendError(ctx, 401, 'invalid_code', 'The code is invalid or expired — request a new one');

    return;
  }

  await createUserSession(ctx, userId);

  ctx.body = prepareObject(await buildMeResponse(userId));
});

async function buildMeResponse(userId: string): Promise<MeResponse> {
  const [workspaceName, mainThread] = await Promise.all([getWorkspaceName(userId), getMainThread(userId)]);

  return { userId, workspaceName, mainThreadId: mainThread?.id ?? null };
}

router.get('/me', requireSession, async ctx => {
  ctx.body = prepareObject(await buildMeResponse(ctx.state.userId as string));
});

router.post('/logout', requireSession, async ctx => {
  await destroySession(ctx, ctx.state.session);

  const response: LogoutResponse = { ok: true };

  ctx.body = prepareObject(response);
});

// --------------------------------------------------------------------------
// The console's starting state and its live tail (src/api/snapshot.ts,
// src/api/event-stream.ts): the store hydrates from the snapshot and follows
// the log from asOfSeq through the stream.

router.get('/snapshot', requireSession, async ctx => {
  const userId = ctx.state.userId as string;

  ctx.body = prepareObject(await buildSnapshot(userId, await buildMeResponse(userId)));
});

const eventStream = createEventStreamHandler({
  hub: getLiveHub(),
  readAfter: (seq, limit) => getEventsAfter(seq, { limit }),
});

router.get('/events/stream', requireSession, ctx => eventStream(ctx));

// --------------------------------------------------------------------------
// The workspace window (read-only): threads and their event feeds.

router.get('/threads', requireSession, async ctx => {
  const userId = ctx.state.userId as string;

  const status = queryValue(ctx.query.status);

  if (status !== undefined && !THREAD_STATUSES.includes(status as ThreadStatus)) {
    sendError(ctx, 400, 'bad_request', `status must be one of: ${THREAD_STATUSES.join(', ')}`);

    return;
  }

  const parentId = queryValue(ctx.query.parentId);
  const projectId = queryValue(ctx.query.projectId);
  const agent = queryValue(ctx.query.agent);
  const q = queryValue(ctx.query.q)?.trim();

  if ((agent !== undefined && agent.length > THREAD_FILTER_MAX) || (q !== undefined && q.length > THREAD_FILTER_MAX)) {
    sendError(ctx, 400, 'bad_request', `agent and q must be at most ${THREAD_FILTER_MAX} characters`);

    return;
  }

  const createdAtGte = parseDateParam(queryValue(ctx.query.createdAtGte));
  const createdAtLte = parseDateParam(queryValue(ctx.query.createdAtLte));

  if (createdAtGte === null || createdAtLte === null) {
    sendError(ctx, 400, 'bad_request', 'createdAtGte/createdAtLte must be valid ISO date-times');

    return;
  }

  const before = queryValue(ctx.query.before);

  if (before !== undefined && !/^\d+$/.test(before)) {
    sendError(ctx, 400, 'bad_request', 'before must be a decimal thread createdSeq cursor');

    return;
  }

  const limit = parseLimitParam(queryValue(ctx.query.limit));

  if (limit === null) {
    sendError(ctx, 400, 'bad_request', `limit must be an integer between 1 and ${LIST_LIMIT_MAX}`);

    return;
  }

  // Newest first, cursor by createdSeq: unique per thread, so equal
  // createdAt timestamps cannot duplicate or skip rows across pages.
  const filters = {
    // The literal "null" selects root threads (no parent).
    ...(parentId !== undefined ? { parentId: parentId === 'null' ? null : parentId } : {}),
    ...(projectId !== undefined ? { projectId } : {}),
    ...(agent !== undefined ? { agent } : {}),
    ...(q ? { q } : {}),
    ...(createdAtGte !== undefined ? { createdAtGte } : {}),
    ...(createdAtLte !== undefined ? { createdAtLte } : {}),
  };
  // The counts ride with the first page only: the set does not change
  // between pages, and later pages are the scroll of the same list.
  const [threads, counted] = await Promise.all([
    listThreads(userId, {
      ...filters,
      ...(status !== undefined ? { status: status as ThreadStatus } : {}),
      ...(before !== undefined ? { beforeCreatedSeq: BigInt(before) } : {}),
      limit,
      order: 'desc',
    }),
    before === undefined ? countThreadsAt(userId, filters) : undefined,
  ]);

  const response: ThreadsResponse = {
    threads,
    nextCursor: threads.length === limit ? threads[threads.length - 1]!.createdSeq : null,
    ...(counted ? { counts: counted.counts, countsAsOfSeq: counted.asOfSeq } : {}),
  };

  ctx.body = prepareObject(response);
});

router.get('/threads/:id', requireSession, async ctx => {
  const thread = await requireOwnThread(ctx, ctx.params.id);

  if (!thread) {
    return;
  }

  const response: ThreadResponse = { thread, headless: await isHeadlessThread(thread.id) };

  ctx.body = prepareObject(response);
});

router.get('/threads/:id/events', requireSession, async ctx => {
  const thread = await requireOwnThread(ctx, ctx.params.id);

  if (!thread) {
    return;
  }

  const before = queryValue(ctx.query.before);
  const after = queryValue(ctx.query.after);

  if ((before !== undefined && !/^\d+$/.test(before)) || (after !== undefined && !/^\d+$/.test(after))) {
    sendError(ctx, 400, 'bad_request', 'before/after must be a decimal event seq cursor');

    return;
  }

  if (before !== undefined && after !== undefined) {
    sendError(ctx, 400, 'bad_request', 'before and after are exclusive');

    return;
  }

  const limit = parseLimitParam(queryValue(ctx.query.limit));

  if (limit === null) {
    sendError(ctx, 400, 'bad_request', `limit must be an integer between 1 and ${LIST_LIMIT_MAX}`);

    return;
  }

  // Cursor by the global seq: unique and insert-ordered, so events sharing
  // a createdAt timestamp page deterministically. Newest first for history
  // (before), oldest first for the live tail (after).
  const events = await listThreadEvents(thread.id, {
    ...(before !== undefined ? { beforeSeq: BigInt(before) } : {}),
    ...(after !== undefined ? { afterSeq: BigInt(after) } : {}),
    limit,
  });

  const response: ThreadEventsResponse = {
    events,
    nextCursor: events.length === limit ? events[events.length - 1]!.seq : null,
  };

  ctx.body = prepareObject(response);
});

// --------------------------------------------------------------------------
// The web chat's inbound: a user.message into one of the session's threads.
// The same canonical event every channel writes (Telegram, CCR) — the
// router wakes the thread's run; the coordinator rises lazily for the main
// thread. The identity is the workspace's one human (the session IS the
// operator's), the source marks the channel for adapters and renderers.

const MESSAGE_TEXT_MAX_CHARS = 20_000;
const WEB_IDENTITY = { username: 'operator' };

router.post('/threads/:id/messages', requireSession, async ctx => {
  const thread = await requireOwnThread(ctx, ctx.params.id);

  if (!thread) {
    return;
  }

  if (thread.status !== 'active') {
    sendError(ctx, 409, 'thread_closed', 'The thread is no longer active');

    return;
  }

  if (await isHeadlessThread(thread.id)) {
    sendError(ctx, 409, 'thread_headless', 'A headless thread takes no user messages — it talks to its parent only');

    return;
  }

  const body = await readJsonBody(ctx);
  const text = typeof body.text === 'string' ? body.text.trim() : '';

  if (!text) {
    sendError(ctx, 400, 'bad_request', 'text must be a non-empty string');

    return;
  }

  if (text.length > MESSAGE_TEXT_MAX_CHARS) {
    sendError(ctx, 400, 'bad_request', `text must be at most ${MESSAGE_TEXT_MAX_CHARS} characters`);

    return;
  }

  const result = await appendEvent({
    type: 'user.message',
    actor: 'user',
    userId: thread.userId,
    threadId: thread.id,
    payload: { text, identity: WEB_IDENTITY, source: 'web' },
  });

  if (!result.written) {
    sendError(ctx, 409, 'thread_closed', 'The thread is no longer active');

    return;
  }

  const response: PostThreadMessageResponse = { event: result.event };

  ctx.body = prepareObject(response);
});

// --------------------------------------------------------------------------
// The thread commands of the console: a soft stop of the turn in flight
// (thread.interrupt — the run stays and waits for the next message) and a
// cancel (thread.cancel → the router aborts the run and writes
// thread.cancelled). Both are one-hop-down commands authored at the parent,
// exactly as the coordinator and the CCR adapter write them; the operator's
// identity rides in the payload. The main thread takes neither: it is
// eternal and nothing addresses it from above.

const CANCEL_REASON_MAX_CHARS = 1_000;

// The active child thread a command may address, or the refusal.
async function requireCommandableThread(ctx: Context, id: string): Promise<(Thread & { parentId: string }) | null> {
  const thread = await requireOwnThread(ctx, id);

  if (!thread) {
    return null;
  }

  if (thread.status !== 'active') {
    sendError(ctx, 409, 'thread_closed', 'The thread is no longer active');

    return null;
  }

  if (!thread.parentId) {
    sendError(ctx, 409, 'thread_main', 'The main thread is eternal — it takes no stop or cancel');

    return null;
  }

  return thread as Thread & { parentId: string };
}

router.post('/threads/:id/interrupt', requireSession, async ctx => {
  const thread = await requireCommandableThread(ctx, ctx.params.id);

  if (!thread) {
    return;
  }

  const result = await appendEvent({
    type: THREAD_INTERRUPT,
    actor: 'user',
    userId: thread.userId,
    threadId: thread.parentId,
    targetThreadId: thread.id,
    payload: { reason: 'interrupted_by_user', identity: WEB_IDENTITY, source: 'web' },
  });

  if (!result.written) {
    sendError(ctx, 409, 'thread_closed', 'The thread is no longer active');

    return;
  }

  const response: ThreadCommandResponse = { event: result.event };

  ctx.body = prepareObject(response);
});

router.post('/threads/:id/cancel', requireSession, async ctx => {
  const thread = await requireCommandableThread(ctx, ctx.params.id);

  if (!thread) {
    return;
  }

  const body = await readJsonBody(ctx);
  const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : 'cancelled by the operator';

  if (reason.length > CANCEL_REASON_MAX_CHARS) {
    sendError(ctx, 400, 'bad_request', `reason must be at most ${CANCEL_REASON_MAX_CHARS} characters`);

    return;
  }

  const result = await appendEvent({
    type: THREAD_CANCEL,
    actor: 'user',
    userId: thread.userId,
    threadId: thread.parentId,
    targetThreadId: thread.id,
    payload: { reason, identity: WEB_IDENTITY, source: 'web' },
  });

  if (!result.written) {
    sendError(ctx, 409, 'thread_closed', 'The thread is no longer active');

    return;
  }

  const response: ThreadCommandResponse = { event: result.event };

  ctx.body = prepareObject(response);
});

// --------------------------------------------------------------------------
// Stored files of the workspace (the attachments of messages), by id, under
// the session: the same ownership rule as the model-facing lookup — a
// foreign file and a missing one answer the same 404. Stored files are
// immutable, so the browser may cache them privately.

router.get('/files/:fileId', requireSession, async ctx => {
  const fileId = ctx.params.fileId as string;
  let file: FileRef;

  try {
    file = await getUserFile(ctx.state.userId as string, fileId);
  } catch {
    sendError(ctx, 404, 'not_found', 'No such file');

    return;
  }

  const contentType = file.contentType ?? 'application/octet-stream';

  ctx.type = contentType;
  ctx.set('x-content-type-options', 'nosniff');
  ctx.set('cache-control', 'private, max-age=3600');
  ctx.set(
    'content-disposition',
    contentDisposition(file.originalFilename ?? fileId, {
      // A stored HTML/SVG/XML/script file rendered inline would run in the
      // session's origin (an agent saved it, an MCP server produced it):
      // active types are always a download, whatever the query says.
      attachment: queryValue(ctx.query.download) === '1' || isActiveContentType(contentType),
    }),
  );

  if (file.sizeBytes !== null) {
    ctx.length = file.sizeBytes;
  }

  ctx.body = Readable.fromWeb(await openFileContent(fileId));
});

// --------------------------------------------------------------------------
// Apps platform: publication management (step 4). The session is the only
// authorization; a rejected call (bad path/slug, broken manifest, taken
// slug) is an AppManagementError → 400 with the reason. This is the owner
// edge — the public edge on the apps domain never shows these details.

router.get('/apps', requireSession, async ctx => {
  const response: AppsResponse = { apps: await listApps(ctx.state.userId as string), publicAppsBase: publicAppsBase() };

  ctx.body = prepareObject(response);
});

async function handleManagementCall(ctx: Context, call: () => Promise<PublicationResponse>): Promise<void> {
  try {
    const response = await call();

    ctx.body = prepareObject(response);
  } catch (error) {
    if (error instanceof AppManagementError) {
      sendError(ctx, 400, 'bad_request', error.message);

      return;
    }

    throw error;
  }
}

router.post('/apps/publish', requireSession, async ctx => {
  const body = await readJsonBody(ctx);

  await handleManagementCall(ctx, () => publishApp(ctx.state.userId as string, body.path, body.slug));
});

router.post('/apps/unpublish', requireSession, async ctx => {
  const body = await readJsonBody(ctx);

  await handleManagementCall(ctx, () => unpublishApp(ctx.state.userId as string, body.path, body.slug));
});

// --------------------------------------------------------------------------
// The project registry (stage 6b): the operator's changes from the console,
// the same implementation the projects_* tools use (src/projects/mutations.ts)
// — the registry row and its project.* event commit together, authored by
// the operator (actor user, no thread). A refusal is a ProjectError whose
// code is the status: 400 the input, 404 a foreign or missing project (one
// answer, no existence oracle), 409 a taken title, slug or folder path.

const PROJECT_ERROR_STATUS: Record<ProjectError['code'], number> = { bad_request: 400, not_found: 404, conflict: 409 };

async function handleProjectCall(ctx: Context, call: () => Promise<ProjectResponse>): Promise<void> {
  try {
    ctx.body = prepareObject(await call());
  } catch (error) {
    if (error instanceof ProjectError) {
      sendError(ctx, PROJECT_ERROR_STATUS[error.code], error.code, error.message);

      return;
    }

    throw error;
  }
}

router.post('/projects', requireSession, async ctx => {
  const userId = ctx.state.userId as string;
  const body = await readJsonBody(ctx);

  await handleProjectCall(ctx, async () => {
    const { project, adopted } = await createProject(userId, parseProjectInput(body), { kind: 'user', userId });
    const response: CreateProjectResponse = { project: projectView(project), adopted };

    return response;
  });
});

router.patch('/projects/:id', requireSession, async ctx => {
  const userId = ctx.state.userId as string;
  const body = await readJsonBody(ctx);

  await handleProjectCall(ctx, async () => {
    const { project } = await updateProject(userId, ctx.params.id as string, parseProjectPatch(body), { kind: 'user', userId });

    return { project: projectView(project) };
  });
});

router.post('/projects/:id/archive', requireSession, async ctx => {
  const userId = ctx.state.userId as string;

  await handleProjectCall(ctx, async () => {
    const { project } = await archiveProject(userId, ctx.params.id as string, { kind: 'user', userId });

    return { project: projectView(project) };
  });
});

router.post('/projects/:id/unarchive', requireSession, async ctx => {
  const userId = ctx.state.userId as string;

  await handleProjectCall(ctx, async () => {
    const { project } = await unarchiveProject(userId, ctx.params.id as string, { kind: 'user', userId });

    return { project: projectView(project) };
  });
});

// --------------------------------------------------------------------------
// LLM request telemetry (read-only): raw rows for the /llm-usage chart.
// The api layer reads the table directly — llm_requests is deliberately
// outside the event log and has no core facade; this endpoint is its only
// reader. rawUsage stays server-side (bulky and unneeded for the chart).

router.get('/llm-requests', requireSession, async ctx => {
  const userId = ctx.state.userId as string;

  const limit = parseLimitParam(queryValue(ctx.query.limit));

  if (limit === null) {
    sendError(ctx, 400, 'bad_request', `limit must be an integer between 1 and ${LIST_LIMIT_MAX}`);

    return;
  }

  // Newest N, then reversed: the client draws oldest-first, left to right.
  const rows = await prisma.llmRequest.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: limit,
    omit: { userId: true, rawUsage: true },
  });

  const response: LlmRequestsResponse = { requests: rows.reverse() };

  ctx.body = prepareObject(response);
});

// --------------------------------------------------------------------------
// The workspace file area (read-only): the user's window into
// data/workspace/<userId>/files, scoped by the session's userId. The path
// boundary is the file-area core's sanitizeRelPath — a rejected path is a
// 400, a missing one a 404. Metadata travels as JSON; raw bytes stream
// separately with an honest content-type.

// undefined = absent/empty (the file-area root); a WorkspacePathError from
// sanitization becomes the 400.
function parseWorkspacePath(ctx: Context): string | null {
  const raw = queryValue(ctx.query.path);

  if (raw === undefined) {
    return '';
  }

  try {
    return sanitizeRelPath(raw);
  } catch (error) {
    sendError(ctx, 400, 'bad_request', error instanceof WorkspacePathError ? error.message : 'Invalid path');

    return null;
  }
}

router.get('/workspace/node', requireSession, async ctx => {
  const userId = ctx.state.userId as string;
  const relPath = parseWorkspacePath(ctx);

  if (relPath === null) {
    return;
  }

  // A directory answers first (the root always does, even unprovisioned —
  // an empty area, not an error); otherwise the path may name a file.
  const listing = await listDir(userId, relPath);

  if (listing) {
    const response: WorkspaceNodeResponse = {
      kind: 'dir',
      path: relPath,
      directories: listing.directories,
      files: listing.files,
    };

    ctx.body = prepareObject(response);

    return;
  }

  const file = await statFile(userId, relPath);

  if (!file) {
    sendError(ctx, 404, 'not_found', 'No such path in the workspace file area');

    return;
  }

  const response: WorkspaceNodeResponse = { kind: 'file', path: relPath, file };

  ctx.body = prepareObject(response);
});

// --------------------------------------------------------------------------
// The root byte surface: GET /files/*path streams one workspace file — the
// raw twin of the /workspace/:path page (same session gate, strictly
// read-only). Inline by default (viewers fetch here), ?download=1 flips to
// attachment. The path lives in the URL — not in a query parameter — so that
// a future index.html-with-assets folder can resolve its relative links by
// the URL alone.

// RFC 6266: an ASCII fallback in filename=, the real name in filename*.
// Content types a browser would execute when rendered inline.
const ACTIVE_CONTENT_TYPES = /^(text\/html|application\/xhtml\+xml|image\/svg\+xml|text\/xml|application\/xml|text\/javascript|application\/(x-)?javascript|application\/ecmascript)\b/i;

function isActiveContentType(contentType: string): boolean {
  return ACTIVE_CONTENT_TYPES.test(contentType.trim());
}

function contentDisposition(filename: string, { attachment }: { attachment: boolean }): string {
  const fallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');

  return `${attachment ? 'attachment' : 'inline'}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

const filesRouter = new Router();

// Signed download links of the local storage driver (src/files/storage.ts):
// GET /files/dl/:fileId?exp=&sig= streams a stored file WITHOUT a session —
// the link is the credential, exactly like a presigned Spaces URL, and it
// expires with exp. Registered before the workspace byte surface so that
// "dl/…" is never read as a workspace path. Always an attachment under the
// original filename: these links are what channels (Telegram) and agents
// hand out as "the file".
filesRouter.get('/files/dl/:fileId', async ctx => {
  const fileId = ctx.params.fileId as string;
  const valid = verifyDownloadLink({
    secret: config.sessionPepper,
    fileId,
    exp: queryValue(ctx.query.exp),
    sig: queryValue(ctx.query.sig),
  });

  if (!valid) {
    sendError(ctx, 403, 'forbidden', 'The download link is invalid or has expired');

    return;
  }

  let file;

  try {
    file = await getFile(fileId);
  } catch {
    sendError(ctx, 404, 'not_found', 'No such file');

    return;
  }

  ctx.set('content-type', file.contentType ?? 'application/octet-stream');
  ctx.set('content-disposition', contentDisposition(file.originalFilename ?? fileId, { attachment: true }));
  ctx.set('cache-control', 'private, no-store');
  ctx.body = Readable.fromWeb(await openFileContent(fileId));

  if (file.sizeBytes !== null) {
    ctx.length = file.sizeBytes;
  }
});

// A bare /files (and /files/ — the trailing slash is optional) names no file.
filesRouter.get('/files', requireSession, ctx => {
  sendError(ctx, 400, 'bad_request', 'The URL must name a file in the workspace file area');
});

filesRouter.get('/files/*path', requireSession, async ctx => {
  const userId = ctx.state.userId as string;

  // Decode the wildcard tail from the raw URL ourselves: the router's own
  // decoding keeps a broken percent-escape silently, we answer 400 instead.
  const rawTail = ctx.path.slice('/files/'.length);
  let decoded: string;

  try {
    decoded = rawTail.split('/').map(decodeURIComponent).join('/');
  } catch {
    sendError(ctx, 400, 'bad_request', 'Malformed percent-encoding in the path');

    return;
  }

  let relPath: string;

  try {
    relPath = sanitizeRelPath(decoded);
  } catch (error) {
    sendError(ctx, 400, 'bad_request', error instanceof WorkspacePathError ? error.message : 'Invalid path');

    return;
  }

  // statFile answers null for missing paths AND directories — both are 404.
  const file = await statFile(userId, relPath);

  if (!file) {
    sendError(ctx, 404, 'not_found', 'No such file in the workspace file area');

    return;
  }

  // Raw bytes, no JSON envelope: the content-type is the honest guess from
  // the extension (a future <img src> works for free), text declares utf-8.
  const filename = relPath.split('/').pop() as string;
  const attachment = queryValue(ctx.query.download) !== undefined;

  ctx.set('content-type', file.mediaType.startsWith('text/') ? `${file.mediaType}; charset=utf-8` : file.mediaType);
  ctx.set('content-disposition', contentDisposition(filename, { attachment }));
  ctx.body = createReadStream(resolveFilePath(userId, relPath));

  if (file.sizeBytes !== null) {
    ctx.length = file.sizeBytes;
  }
});

// The cross-site guard of every mutation under the session (src/api/origin.ts):
// a page of another origin holding the browser's cookie is refused before any
// route runs. True for the error reply already sent.
function refuseCrossSite(ctx: Context): boolean {
  const verdict = checkMutationOrigin({
    method: ctx.method,
    protocol: ctx.protocol,
    host: ctx.host,
    secFetchSite: ctx.get('sec-fetch-site') || undefined,
    origin: ctx.get('origin') || undefined,
  });

  if (verdict === 'ok') {
    return false;
  }

  sendError(ctx, 403, 'cross_site', 'Cross-site requests are not accepted');

  return true;
}

export function createFilesMiddleware(): (ctx: Context, next: Next) => Promise<void> {
  const routes = filesRouter.routes() as unknown as (ctx: Context, next: () => Promise<void>) => Promise<void>;

  return async (ctx, next) => {
    if (ctx.path !== '/files' && !ctx.path.startsWith('/files/')) {
      await next();

      return;
    }

    if (refuseCrossSite(ctx)) {
      return;
    }

    try {
      await routes(ctx, async () => {});
    } catch (error) {
      console.error('[files] unhandled error:', error);
      sendError(ctx, 500, 'internal_error', 'Internal error');

      return;
    }

    if (ctx.status === 404 && ctx.body === undefined) {
      sendError(ctx, 404, 'not_found', `No such endpoint: ${ctx.method} ${ctx.path}`);
    }
  };
}

// --------------------------------------------------------------------------
// Secret provisioning: the trusted window (§2 ставка 4). The GET exposes
// field metadata only; the POST hands the values to the existing
// provisioning machinery — values land in storage, the log gets a sanitized
// event, the response carries nothing back. One id namespace over both
// request kinds; a foreign or missing id is the same 404.

async function resolveSecretRequest(userId: string, requestId: string): Promise<SecretRequestView | null> {
  const external = await getExternalServerSecretRequest(userId, requestId);

  if (external) {
    return {
      id: external.id,
      kind: 'external-secrets',
      server: external.server,
      fields: external.fields.map(field => ({
        key: field.key,
        label: field.key,
        description: field.description,
        required: true,
        secret: true,
      })),
    };
  }

  const oauthClient = await getOauthClientRequest(userId, requestId);

  if (oauthClient) {
    return {
      id: oauthClient.id,
      kind: 'oauth-client',
      server: oauthClient.server,
      fields: [
        {
          key: 'client_id',
          label: 'Client ID',
          description: 'OAuth client identifier issued by the provider',
          required: true,
          secret: false,
        },
        {
          key: 'client_secret',
          label: 'Client secret',
          description: 'Leave empty for a public client',
          required: false,
          secret: true,
        },
      ],
    };
  }

  return null;
}

router.get('/secret-requests/:id', requireSession, async ctx => {
  const request = await resolveSecretRequest(ctx.state.userId as string, ctx.params.id);

  if (!request) {
    sendError(ctx, 404, 'not_found', 'No such secret request — it may already be fulfilled');

    return;
  }

  const response: SecretRequestResponse = { request };

  ctx.body = prepareObject(response);
});

router.post('/secret-requests/:id', requireSession, async ctx => {
  const userId = ctx.state.userId as string;
  const request = await resolveSecretRequest(userId, ctx.params.id);

  if (!request) {
    sendError(ctx, 404, 'not_found', 'No such secret request — it may already be fulfilled');

    return;
  }

  const body = await readJsonBody(ctx);
  const rawValues = body.values;
  const values: Record<string, string> = {};

  if (typeof rawValues === 'object' && rawValues !== null && !Array.isArray(rawValues)) {
    for (const [key, value] of Object.entries(rawValues)) {
      if (typeof value === 'string') {
        values[key] = value;
      }
    }
  }

  try {
    if (request.kind === 'external-secrets') {
      await provisionExternalServerSecrets(userId, request.id, values);
    } else {
      await provisionOauthClient(userId, request.id, values.client_id ?? '', values.client_secret ?? '');
    }
  } catch (error) {
    sendError(ctx, 400, 'provisioning_failed', error instanceof Error ? error.message : String(error));

    return;
  }

  const response: ProvisionSecretsResponse = { ok: true };

  ctx.body = prepareObject(response);
});

export function createApiMiddleware(): (ctx: Context, next: Next) => Promise<void> {
  // The router's dispatch wants its own context flavor (params/router); at
  // runtime it only adds those fields, so a plain Koa context is fine here.
  const routes = router.routes() as unknown as (ctx: Context, next: () => Promise<void>) => Promise<void>;

  return async (ctx, next) => {
    if (ctx.path !== '/api' && !ctx.path.startsWith('/api/')) {
      await next();

      return;
    }

    if (refuseCrossSite(ctx)) {
      return;
    }

    try {
      await routes(ctx, async () => {});
    } catch (error) {
      console.error('[api] unhandled error:', error);
      sendError(ctx, 500, 'internal_error', 'Internal error');

      return;
    }

    if (ctx.status === 404 && ctx.body === undefined) {
      sendError(ctx, 404, 'not_found', `No such endpoint: ${ctx.method} ${ctx.path}`);
    }
  };
}
