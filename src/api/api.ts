// The /api namespace: JSON over the session, the second interface's server
// side. The userId comes ONLY from the session — no endpoint accepts it from
// the request. Bodies cross the wire through serialize-json in both
// directions (bigint/Date survive), errors share one shape
// ({error: {code, message}}), and an unmatched /api path answers JSON 404
// instead of falling through to other middleware.

import Router from '@koa/router';
import { Api } from 'grammy';
import type { Context, Next } from 'koa';
import { prisma } from '../db/client.ts';
import { config } from '../config/index.ts';
import { parseJson, prepareObject } from '../utils/serialize-json.ts';
import { getMainThread, getThread, listThreads } from '../core/threads.ts';
import { listThreadEvents } from '../core/events.ts';
import type { Thread, ThreadStatus } from '../core/contract.ts';
import { getExternalServerSecretRequest, provisionExternalServerSecrets } from '../capabilities/external-secrets.ts';
import { getOauthClientRequest, provisionOauthClient } from '../capabilities/connections/index.ts';
import { consumeAuthCode } from './auth-codes.ts';
import { createUserSession, destroySession, getSession } from './session.ts';
import type {
  LogoutResponse,
  MeResponse,
  ProvisionSecretsResponse,
  SecretRequestResponse,
  SecretRequestView,
  ThreadEventsResponse,
  ThreadResponse,
  ThreadsResponse,
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
// a failure degrades to null, never to an error.
const telegramApi = new Api(config.telegramBotToken);
const workspaceNameCache = new Map<string, { name: string | null; fetchedAt: number }>();
const WORKSPACE_NAME_TTL_MS = 10 * 60 * 1000;

async function getWorkspaceName(userId: string): Promise<string | null> {
  const cached = workspaceNameCache.get(userId);

  if (cached && Date.now() - cached.fetchedAt < WORKSPACE_NAME_TTL_MS) {
    return cached.name;
  }

  let name: string | null = null;

  try {
    const group = await prisma.telegramGroup.findUnique({ where: { userId } });

    if (group) {
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

router.post('/auth', async ctx => {
  const body = await readJsonBody(ctx);
  const code = typeof body.code === 'string' ? body.code : '';
  const userId = code ? consumeAuthCode(code) : null;

  if (!userId) {
    sendError(ctx, 401, 'invalid_code', 'The code is invalid or expired — request a new one with /auth_code');

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
// The workspace window (read-only): threads and their event feeds.

router.get('/threads', requireSession, async ctx => {
  const userId = ctx.state.userId as string;

  const status = queryValue(ctx.query.status);

  if (status !== undefined && !THREAD_STATUSES.includes(status as ThreadStatus)) {
    sendError(ctx, 400, 'bad_request', `status must be one of: ${THREAD_STATUSES.join(', ')}`);

    return;
  }

  const parentId = queryValue(ctx.query.parentId);
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
  const threads = await listThreads(userId, {
    ...(status !== undefined ? { status: status as ThreadStatus } : {}),
    // The literal "null" selects root threads (no parent).
    ...(parentId !== undefined ? { parentId: parentId === 'null' ? null : parentId } : {}),
    ...(createdAtGte !== undefined ? { createdAtGte } : {}),
    ...(createdAtLte !== undefined ? { createdAtLte } : {}),
    ...(before !== undefined ? { beforeCreatedSeq: BigInt(before) } : {}),
    limit,
    order: 'desc',
  });

  const response: ThreadsResponse = {
    threads,
    nextCursor: threads.length === limit ? threads[threads.length - 1]!.createdSeq : null,
  };

  ctx.body = prepareObject(response);
});

router.get('/threads/:id', requireSession, async ctx => {
  const thread = await requireOwnThread(ctx, ctx.params.id);

  if (!thread) {
    return;
  }

  const response: ThreadResponse = { thread };

  ctx.body = prepareObject(response);
});

router.get('/threads/:id/events', requireSession, async ctx => {
  const thread = await requireOwnThread(ctx, ctx.params.id);

  if (!thread) {
    return;
  }

  const before = queryValue(ctx.query.before);

  if (before !== undefined && !/^\d+$/.test(before)) {
    sendError(ctx, 400, 'bad_request', 'before must be a decimal event seq cursor');

    return;
  }

  const limit = parseLimitParam(queryValue(ctx.query.limit));

  if (limit === null) {
    sendError(ctx, 400, 'bad_request', `limit must be an integer between 1 and ${LIST_LIMIT_MAX}`);

    return;
  }

  // Newest first, cursor by the global seq: unique and insert-ordered, so
  // events sharing a createdAt timestamp page deterministically.
  const events = await listThreadEvents(thread.id, {
    ...(before !== undefined ? { beforeSeq: BigInt(before) } : {}),
    limit,
  });

  const response: ThreadEventsResponse = {
    events,
    nextCursor: events.length === limit ? events[events.length - 1]!.seq : null,
  };

  ctx.body = prepareObject(response);
});

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
