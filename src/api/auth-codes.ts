// In-memory one-time auth codes for linking a web session to a telegram
// user. Ported from v1 src/auth-codes as is. Deliberately not persisted: a
// restart just invalidates pending codes.

import crypto from 'node:crypto';

const CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const CODE_LENGTH = 8;
// Uppercase alphabet without ambiguous characters (0/O, 1/I/L)
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

type PendingCode = {
  userId: string;
  expiresAt: number;
};

const codes = new Map<string, PendingCode>();

function sweepExpired(): void {
  const now = Date.now();

  for (const [code, entry] of codes) {
    if (entry.expiresAt <= now) {
      codes.delete(code);
    }
  }
}

export function createAuthCode(userId: string): string {
  sweepExpired();

  // Only one active code per user: a new request invalidates the previous code
  for (const [code, entry] of codes) {
    if (entry.userId === userId) {
      codes.delete(code);
    }
  }

  const bytes = crypto.randomBytes(CODE_LENGTH);
  let code = '';

  for (const byte of bytes) {
    code += ALPHABET[byte % ALPHABET.length];
  }

  codes.set(code, { userId, expiresAt: Date.now() + CODE_TTL_MS });

  return code;
}

/**
 * Returns the userId for a valid code and invalidates it (one-time use).
 */
export function consumeAuthCode(input: string): string | null {
  sweepExpired();

  const code = input.trim().toUpperCase();
  const entry = codes.get(code);

  if (!entry) {
    return null;
  }

  codes.delete(code);

  return entry.userId;
}
