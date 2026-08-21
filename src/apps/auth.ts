// Owner auth of the apps domain (step 3 of the /apps plan): the one-time
// handoff token minted on the main domain and the stateless HMAC apps
// cookie it is exchanged for on balabash.app/auth.
//
// The token is in-memory on purpose (the pattern of src/api/auth-codes.ts):
// a restart between mint and exchange only costs one extra round of the
// self-refresh loop. The cookie is stateless signed state — {userId, exp,
// kind:'apps'} under an HMAC with its own secret — so it needs no table, no
// memory, and survives restarts. Revocation is by TTL only (design №7).

import crypto from 'node:crypto';
import { config } from '../config/index.ts';

const TOKEN_TTL_MS = 60 * 1000; // the mint→exchange window is one redirect
const COOKIE_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours, then the refresh loop

export const APPS_COOKIE_NAME = 'apps_auth';
export const APPS_COOKIE_MAX_AGE_MS = COOKIE_TTL_MS;

// --------------------------------------------------------------------------
// One-time handoff tokens.

type PendingToken = {
  userId: string;
  expiresAt: number;
};

const tokens = new Map<string, PendingToken>();

function sweepExpiredTokens(): void {
  const now = Date.now();

  for (const [token, entry] of tokens) {
    if (entry.expiresAt <= now) {
      tokens.delete(token);
    }
  }
}

/** Mints a one-time token bound to the userId; expires in ~60 seconds. */
export function mintHandoffToken(userId: string): string {
  sweepExpiredTokens();

  const token = crypto.randomBytes(32).toString('base64url');

  tokens.set(token, { userId, expiresAt: Date.now() + TOKEN_TTL_MS });

  return token;
}

/**
 * Exchanges a token for its userId and burns it (one-time use): a second
 * exchange of the same token fails no matter how fresh it is.
 */
export function consumeHandoffToken(token: string): string | null {
  sweepExpiredTokens();

  const entry = tokens.get(token);

  if (!entry) {
    return null;
  }

  tokens.delete(token);

  return entry.userId;
}

// --------------------------------------------------------------------------
// The apps cookie: base64url(JSON payload) + '.' + HMAC-SHA256 signature.

type AppsCookiePayload = {
  userId: string;
  exp: number;
  kind: 'apps';
};

function signPayload(payload: string): string {
  return crypto.createHmac('sha256', config.appsCookieSecret).update(payload).digest('base64url');
}

/** Builds a signed cookie value for the userId, expiring in COOKIE_TTL_MS. */
export function createAppsCookieValue(userId: string): string {
  const payload: AppsCookiePayload = { userId, exp: Date.now() + COOKIE_TTL_MS, kind: 'apps' };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');

  return `${encoded}.${signPayload(encoded)}`;
}

/**
 * Verifies a cookie value and returns its userId, or null: a missing value,
 * a broken signature, an expired payload and a foreign kind all look the
 * same to the caller. kind:'apps' keeps the cookie meaningless on the main
 * domain even if the value ever leaks there.
 */
export function verifyAppsCookieValue(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  const dot = value.lastIndexOf('.');

  if (dot <= 0) {
    return null;
  }

  const encoded = value.slice(0, dot);
  const signature = Buffer.from(value.slice(dot + 1));
  const expected = Buffer.from(signPayload(encoded));

  if (signature.length !== expected.length || !crypto.timingSafeEqual(signature, expected)) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));

    if (typeof parsed !== 'object' || parsed === null) {
      return null;
    }

    const { userId, exp, kind } = parsed as Record<string, unknown>;

    if (kind !== 'apps' || typeof userId !== 'string' || !userId) {
      return null;
    }

    if (typeof exp !== 'number' || exp <= Date.now()) {
      return null;
    }

    return userId;
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------------
// Redirect validation (anti open-redirect, the sanitizeNextPath pattern):
// only a local /apps path of the apps domain survives as a destination.

export function sanitizeAppsRedirect(value: unknown): string {
  if (typeof value === 'string' && (value === '/apps' || value.startsWith('/apps/'))) {
    return value;
  }

  return '/apps';
}
