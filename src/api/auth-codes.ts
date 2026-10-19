// In-memory one-time auth codes for signing a web session in: a code is
// issued to a user for a workspace — by a channel that knows who asked
// (Telegram /auth_code, the account behind the command) or by the /login
// page itself for the installation's operator (the console code, printed
// to the server log — api.ts). Deliberately not persisted: a restart just
// invalidates pending codes.
//
// A code remembers where it was issued (LoginSource): the session born from
// it records that, and Settings tells the operator how this browser got in.

import crypto from 'node:crypto';
import type { LoginSource } from './contract.ts';

const CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const CODE_LENGTH = 8;
// Uppercase alphabet without ambiguous characters (0/O, 1/I/L)
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

// Whom a code signs in, and where.
export type AuthGrant = { workspaceId: string; userId: string };

type PendingCode = AuthGrant & {
  source: LoginSource;
  expiresAt: number;
};

export type ConsumedCode = AuthGrant & { source: LoginSource };

const codes = new Map<string, PendingCode>();

function sweepExpired(): void {
  const now = Date.now();

  for (const [code, entry] of codes) {
    if (entry.expiresAt <= now) {
      codes.delete(code);
    }
  }
}

export function createAuthCode(grant: AuthGrant, source: LoginSource): string {
  sweepExpired();

  // One active code per user and workspace: a new request invalidates the
  // previous code of the same person (another member's stays).
  for (const [code, entry] of codes) {
    if (entry.workspaceId === grant.workspaceId && entry.userId === grant.userId) {
      codes.delete(code);
    }
  }

  const bytes = crypto.randomBytes(CODE_LENGTH);
  let code = '';

  for (const byte of bytes) {
    code += ALPHABET[byte % ALPHABET.length];
  }

  codes.set(code, { ...grant, source, expiresAt: Date.now() + CODE_TTL_MS });

  return code;
}

/**
 * Returns the grant and the source for a valid code and invalidates it
 * (one-time use).
 */
export function consumeAuthCode(input: string): ConsumedCode | null {
  sweepExpired();

  const code = input.trim().toUpperCase();
  const entry = codes.get(code);

  if (!entry) {
    return null;
  }

  codes.delete(code);

  return { workspaceId: entry.workspaceId, userId: entry.userId, source: entry.source };
}
