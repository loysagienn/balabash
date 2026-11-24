// Pairing codes: what the console hands to the extension of the browser it
// is open in, so that the browser's first `hello` can say whose it is
// (protocol.ts). A code stands for the user and the workspace of the
// session that asked for it and for the name the user typed; it is random,
// lives for ten minutes and one use.
//
// The codes are the process's memory: a restart of the app loses them, and
// the user presses the button again.

import { randomBytes } from 'node:crypto';

const CODE_TTL_MS = 10 * 60_000;

export type Pairing = { userId: string; workspaceId: string; name: string };

export type Pairings = {
  issue(pairing: Pairing): { code: string; expiresAt: Date };
  // The pairing behind the code, once; null for a code that is unknown,
  // used or expired.
  redeem(code: string): Pairing | null;
};

export function createPairings(now: () => number = Date.now): Pairings {
  const pending = new Map<string, { pairing: Pairing; expiresAt: number }>();

  return {
    issue(pairing) {
      for (const [code, entry] of pending) {
        if (entry.expiresAt <= now()) {
          pending.delete(code);
        }
      }

      const code = randomBytes(32).toString('base64url');
      const expiresAt = now() + CODE_TTL_MS;

      pending.set(code, { pairing, expiresAt });

      return { code, expiresAt: new Date(expiresAt) };
    },

    redeem(code) {
      const entry = pending.get(code);

      if (!entry) {
        return null;
      }

      pending.delete(code);

      return entry.expiresAt > now() ? entry.pairing : null;
    },
  };
}
