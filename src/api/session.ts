// Web sessions: a long-lived httpOnly cookie backed by the web_sessions
// table, surviving restarts. Ported from v1 src/web/server/utils/session.ts
// with two agreed changes: the cookie is host-only (no Domain attribute) and
// sessions are created ONLY on a successful auth-code exchange — anonymous
// visitors never touch the database. Everything else is as in v1: the raw
// token lives only in the cookie, the DB stores a sha256(token + pepper)
// hash, the token rotates after 24 hours, the session slides for 30 days,
// lastUsed updates are rate-limited.

import crypto from 'node:crypto';
import type { Context } from 'koa';
import { prisma } from '../db/client.ts';
import { config } from '../config/index.ts';
import type { SessionModel } from '../../prisma-generated/models.ts';

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

function clearSessionCookie(ctx: Context): void {
  ctx.cookies.set(SESSION_ID_COOKIE_NAME, null, {
    sameSite: COOKIE_OPTIONS.sameSite,
    httpOnly: COOKIE_OPTIONS.httpOnly,
    secure: COOKIE_OPTIONS.secure,
    path: COOKIE_OPTIONS.path,
  });
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
  const cookieToken = ctx.cookies.get(SESSION_ID_COOKIE_NAME);

  if (!cookieToken) {
    return null;
  }

  const session = await prisma.session.findUnique({ where: { tokenHash: hashSessionToken(cookieToken) } });

  if (!session) {
    clearSessionCookie(ctx);

    return null;
  }

  if (isSessionExpired(session)) {
    await prisma.session.deleteMany({ where: { id: session.id } });
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
 * sets the cookie. This is the ONLY place a session row is born.
 */
export async function createUserSession(ctx: Context, userId: string): Promise<SessionModel> {
  const token = generateSessionToken();

  const session = await prisma.session.create({
    data: {
      userAgent: ctx.headers['user-agent'] || '',
      userId,
      tokenHash: hashSessionToken(token),
      lastUsed: new Date(),
    },
  });

  ctx.cookies.set(SESSION_ID_COOKIE_NAME, token, COOKIE_OPTIONS);

  return session;
}

/**
 * Deletes the session row and clears the cookie (logout).
 */
export async function destroySession(ctx: Context, session: SessionModel): Promise<void> {
  await prisma.session.deleteMany({ where: { id: session.id } });
  clearSessionCookie(ctx);
}
