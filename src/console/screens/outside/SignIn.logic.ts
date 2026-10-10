// The sign-in form's words and ways, kept pure: the word that asks for a
// code instead of being one, what the button says while waiting, what the
// field says about an error, and where the /login door leads once the
// session is there.

import { isLocalPath, readRoute } from '../../lib/router/routes.ts';
import type { AppRoute } from '../../lib/router/routes.ts';
import type { ApiFailure } from '../../lib/api/index.ts';
import type { LoginPending } from '../../store/session/reducer.ts';

// Typed into the code field instead of a code: asks the server to print a
// login code for the operator's workspace into its own log — the way in
// without any channel (the operator reads the log over ssh).
export const CONSOLE_WORD = 'console';

export function isConsoleWord(code: string): boolean {
  return code.trim().toLowerCase() === CONSOLE_WORD;
}

// The field's hint once the server has printed a code (the code itself
// never crosses the wire; the server keeps it for ten minutes).
export const CODE_PRINTED_HINT = 'The code is printed in the server log — read it there and enter it here within 10 minutes.';

export function submitLabel(pending: LoginPending): string {
  switch (pending) {
    case 'sign-in':
      return 'Signing in';
    case 'console-code':
      return 'Requesting a code';
    case null:
      return 'Sign in';
  }
}

// Under the field: the design's words for a refused code; the server's for
// anything else (a code printed moments ago — 429 —, a network failure).
export function errorWords(error: ApiFailure): string {
  return error.status === 401 ? 'Invalid or expired code.' : error.message;
}

// Where the signed-in /login door leads. A path the SPA reads is entered in
// place (with its fragment); a path it does not serve — the owner page of
// an app under /apps/<path>, the shared surfaces — is a full navigation to
// the same host. No destination, another origin or the door itself — Home.
export type LoginDestination = { kind: 'route'; route: AppRoute; hash: string } | { kind: 'url'; url: string };

export function loginDestination(next: string | undefined): LoginDestination {
  const home: LoginDestination = { kind: 'route', route: { key: 'home' }, hash: '' };

  if (!next || !isLocalPath(next)) {
    return home;
  }

  const route = readRoute(next);

  if (route.key === 'login') {
    return home;
  }

  if (route.key === 'not_found') {
    return { kind: 'url', url: next };
  }

  const hashAt = next.indexOf('#');

  return { kind: 'route', route, hash: hashAt >= 0 ? next.slice(hashAt) : '' };
}
