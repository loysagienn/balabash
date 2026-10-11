// Web sessions: a long-lived httpOnly cookie backed by the web_sessions
// table, surviving restarts. Ported from v1 src/web/server/utils/session.ts
// with two agreed changes: the cookie is host-only (no Domain attribute) and
// sessions are created ONLY on a successful auth-code exchange — anonymous
// visitors never touch the database. Everything else is as in v1: the raw
// token lives only in the cookie, the DB stores a sha256(token + pepper)
// hash, the token rotates after 24 hours, the session slides for 30 days,
// lastUsed updates are rate-limited. One session holds every workspace the
// browser is signed in to (see "Several workspaces" below).

import crypto from 'node:crypto';
import type { Context } from 'koa';
import { prisma } from '../db/client.ts';
import { config } from '../config/index.ts';
import type { SessionModel, SessionWorkspaceModel } from '../../prisma-generated/models.ts';
import type { LoginSource } from './contract.ts';

const SESSION_ID_COOKIE_NAME = 'session_id';
const SESSION_TOKEN_BYTES = 32;
const SESSION_ROTATE_AFTER_MS = 24 * 60 * 60 * 1000; // 24 hours
const SESSION_LAST_USED_UPDATE_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
const SESSION_COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // sliding 30 days

// Host-only cookie: no Domain attribute, so the cookie sticks to the exact
// host it was set on and never leaks to sibling subdomains.
const COOKIE_OPTIONS = {
  maxAge: SESSION_COOKIE_MAX_AGE_MS,
  sameSite: 'lax',
  httpOnly: true,
  secure: true,
  path: '/',
} as const;

function generateSessionToken(): string {
  return crypto.randomBytes(SESSION_TOKEN_BYTES).toString('base64url');
}

// IMPORTANT: never log or expose the raw token.
function hashSessionToken(token: string): string {
  return crypto
    .createHash('sha256')
    .update(token + config.sessionPepper)
    .digest('hex');
}

function shouldRotateToken(session: SessionModel): boolean {
  const referenceTime = session.rotatedAt ?? session.lastUsed ?? session.createdAt;

  return Date.now() - referenceTime.getTime() > SESSION_ROTATE_AFTER_MS;
}

function shouldUpdateLastUsed(session: SessionModel): boolean {
  if (!session.lastUsed) {
    return true;
  }

  return Date.now() - session.lastUsed.getTime() > SESSION_LAST_USED_UPDATE_INTERVAL_MS;
}

function isSessionExpired(session: SessionModel): boolean {
  const referenceTime = session.lastUsed ?? session.createdAt;

  return Date.now() - referenceTime.getTime() > SESSION_COOKIE_MAX_AGE_MS;
}

// Balabash v1 set this cookie with Domain=.<host>. A browser that still
// holds that legacy cookie sends BOTH values under the same name, the stale
// one first — shadowing every fresh host-only session. Expire the legacy
// domain cookie explicitly; the host-only clear cannot reach it.
function clearLegacySessionCookie(ctx: Context): void {
  ctx.cookies.set(SESSION_ID_COOKIE_NAME, null, {
    domain: `.${ctx.hostname}`,
    sameSite: COOKIE_OPTIONS.sameSite,
    httpOnly: COOKIE_OPTIONS.httpOnly,
    secure: COOKIE_OPTIONS.secure,
    path: COOKIE_OPTIONS.path,
  });
}

function clearSessionCookie(ctx: Context): void {
  ctx.cookies.set(SESSION_ID_COOKIE_NAME, null, {
    sameSite: COOKIE_OPTIONS.sameSite,
    httpOnly: COOKIE_OPTIONS.httpOnly,
    secure: COOKIE_OPTIONS.secure,
    path: COOKIE_OPTIONS.path,
  });
  clearLegacySessionCookie(ctx);
}

// ctx.cookies.get returns only the FIRST value when duplicate cookies share
// the name (host-only + legacy domain cookie), so read them all by hand.
function getSessionCookieValues(ctx: Context): string[] {
  const header = ctx.headers.cookie;

  if (!header) {
    return [];
  }

  const values: string[] = [];

  for (const part of header.split(';')) {
    const eq = part.indexOf('=');

    if (eq === -1) {
      continue;
    }

    if (part.slice(0, eq).trim() === SESSION_ID_COOKIE_NAME) {
      const value = part.slice(eq + 1).trim();

      if (value) {
        values.push(value);
      }
    }
  }

  return values;
}

async function rotateSessionToken(ctx: Context, session: SessionModel): Promise<SessionModel> {
  const newToken = generateSessionToken();
  const now = new Date();

  const newSession = await prisma.session.update({
    where: { id: session.id },
    data: { tokenHash: hashSessionToken(newToken), rotatedAt: now, lastUsed: now },
  });

  ctx.cookies.set(SESSION_ID_COOKIE_NAME, newToken, COOKIE_OPTIONS);

  return newSession;
}

/**
 * Resolves the session behind the request cookie, or null: a missing cookie,
 * an unknown token and an expired row all look the same to the caller.
 * Handles token rotation and the rate-limited lastUsed touch on the way.
 */
export async function getSession(ctx: Context): Promise<SessionModel | null> {
  const cookieTokens = getSessionCookieValues(ctx);

  if (cookieTokens.length === 0) {
    return null;
  }

  // Duplicate values mean the legacy v1 domain cookie is still around —
  // expire it, then keep serving whichever value matches a live session.
  if (cookieTokens.length > 1) {
    clearLegacySessionCookie(ctx);
  }

  let session: SessionModel | null = null;

  for (const cookieToken of cookieTokens) {
    session = await prisma.session.findUnique({ where: { tokenHash: hashSessionToken(cookieToken) } });

    if (session) {
      break;
    }
  }

  if (!session) {
    clearSessionCookie(ctx);

    return null;
  }

  if (isSessionExpired(session)) {
    await deleteSessionRows(session.id);
    clearSessionCookie(ctx);

    return null;
  }

  if (shouldRotateToken(session)) {
    // lastUsed is updated as part of rotation.
    return rotateSessionToken(ctx, session);
  }

  if (shouldUpdateLastUsed(session)) {
    // Fire-and-forget: don't block the request on the touch.
    prisma.session
      .update({ where: { id: session.id }, data: { lastUsed: new Date() } })
      .catch(() => console.error('[web] failed to update session lastUsed timestamp'));
  }

  return session;
}

/**
 * Creates a session for a user who just exchanged a one-time auth code and
 * sets the cookie. This is the ONLY place a session row is born; the
 * workspace the code was for is its first (and primary) workspace.
 */
export async function createUserSession(ctx: Context, userId: string, loginSource: LoginSource): Promise<SessionModel> {
  const token = generateSessionToken();

  const session = await prisma.$transaction(async tx => {
    const row = await tx.session.create({
      data: {
        userAgent: ctx.headers['user-agent'] || '',
        userId,
        tokenHash: hashSessionToken(token),
        lastUsed: new Date(),
        loginSource,
      },
    });

    await tx.sessionWorkspace.create({ data: { sessionId: row.id, userId, createdAt: row.createdAt, loginSource } });

    return row;
  });

  ctx.cookies.set(SESSION_ID_COOKIE_NAME, token, COOKIE_OPTIONS);
  // The login response also kills the legacy v1 domain cookie, so the fresh
  // host-only session is never shadowed by a stale value.
  clearLegacySessionCookie(ctx);

  return session;
}

// ---------------------------------------------------------------------------
// Several workspaces in one browser: one cookie, one session, the
// workspaces it is signed in to (web_session_workspaces). Each request acts
// in one of them — the one it names (the header for fetches, ?ws= for what
// the browser loads by itself: the event stream, file bytes, a link), or
// the session's primary one when it names none. The primary
// (web_sessions.user_id) is always a signed-in workspace: signing out of it
// hands the role to the oldest remaining one.

export const WORKSPACE_HEADER = 'x-balabash-workspace';
export const WORKSPACE_QUERY = 'ws';

// The workspace the request names, or null: the header first, then ?ws=.
export function requestedWorkspace(ctx: Context): string | null {
  const header = ctx.get(WORKSPACE_HEADER).trim();

  if (header) {
    return header;
  }

  const query = ctx.query[WORKSPACE_QUERY];
  const value = (Array.isArray(query) ? query[0] : query)?.trim();

  return value || null;
}

// The workspace a request of this session acts in: the one it names, when
// the session is signed in to it; the primary one when it names none.
// null — it names a workspace this session is not signed in to (signed out
// of it elsewhere, or never signed in here).
export async function resolveWorkspace(session: SessionModel, requested: string | null): Promise<string | null> {
  if (!session.userId) {
    return null;
  }

  if (requested === null || requested === session.userId) {
    return session.userId;
  }

  const binding = await prisma.sessionWorkspace.findUnique({ where: { sessionId_userId: { sessionId: session.id, userId: requested } } });

  return binding ? requested : null;
}

// The workspaces of a session in the order they were signed in to.
export function listSessionWorkspaces(sessionId: string): Promise<SessionWorkspaceModel[]> {
  return prisma.sessionWorkspace.findMany({ where: { sessionId }, orderBy: [{ createdAt: 'asc' }, { userId: 'asc' }] });
}

/**
 * Signs this browser in to the workspace of an exchanged code: a browser
 * with a live session adds the workspace to it (signing in to a workspace
 * it already has changes nothing), any other gets a new session.
 */
export async function signInWorkspace(ctx: Context, userId: string, loginSource: LoginSource): Promise<SessionModel> {
  const session = await getSession(ctx);

  if (!session || !session.userId) {
    return createUserSession(ctx, userId, loginSource);
  }

  await prisma.sessionWorkspace.upsert({
    where: { sessionId_userId: { sessionId: session.id, userId } },
    create: { sessionId: session.id, userId, loginSource },
    update: {},
  });

  return session;
}

/**
 * Signs this browser out of one workspace. Answers the workspaces still
 * signed in, in order; the last one gone ends the session itself (the row
 * and the cookie).
 */
export async function signOutWorkspace(ctx: Context, session: SessionModel, userId: string): Promise<string[]> {
  const remaining = await prisma.$transaction(async tx => {
    await tx.sessionWorkspace.deleteMany({ where: { sessionId: session.id, userId } });

    const rows = await tx.sessionWorkspace.findMany({ where: { sessionId: session.id }, orderBy: [{ createdAt: 'asc' }, { userId: 'asc' }] });

    if (rows.length === 0) {
      await tx.session.deleteMany({ where: { id: session.id } });
    } else if (!rows.some(row => row.userId === session.userId)) {
      await tx.session.update({ where: { id: session.id }, data: { userId: rows[0]!.userId } });
    }

    return rows.map(row => row.userId);
  });

  if (remaining.length === 0) {
    clearSessionCookie(ctx);
  }

  return remaining;
}

async function deleteSessionRows(sessionId: string): Promise<void> {
  await prisma.$transaction([prisma.sessionWorkspace.deleteMany({ where: { sessionId } }), prisma.session.deleteMany({ where: { id: sessionId } })]);
}
