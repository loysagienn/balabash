// The browser SDK of the apps platform, served as the vendor module
// 'balabash/data'. The whole data surface of an app: call(name, params)
// executes an endpoint declared in the app's manifest. Apps never write the
// auth logic — on a 401 in owner mode the SDK itself sends the browser
// through the cookie-refresh loop (refreshUrl → main domain → token handoff
// → back).
//
// This file is compiled by build/server.js into dist/apps-vendor/
// balabash-data.js; it runs in the browser, so DOM globals are reached
// through globalThis (the core tsconfig has no DOM lib).

export type AppMode = 'owner' | 'public';

export type AppContext = {
  mode: AppMode;
  /** URL base of the app's endpoint calls, no trailing slash. */
  apiBase: string;
  /** Workspace path of the app (owner mode). */
  appPath?: string;
  /** Public slug (public mode). */
  slug?: string;
  /** Owner mode: where to send the browser to refresh the apps cookie. */
  refreshUrl?: string;
};

type BalabashGlobal = { __BALABASH_APP__?: AppContext; location?: { assign(url: string): void } };

export function getAppContext(): AppContext {
  const context = (globalThis as BalabashGlobal).__BALABASH_APP__;

  if (!context) {
    throw new Error('balabash/data: no app context — this page is not served by the Balabash apps runtime');
  }

  return context;
}

/**
 * Calls a declared endpoint of this app's manifest. Resolves with the
 * statement result (rows for 'all', one row or null for 'get',
 * {changes, lastInsertRowid} for 'run'); rejects with the platform's error
 * message otherwise.
 */
export async function call(name: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const context = getAppContext();

  const response = await fetch(`${context.apiBase}/${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ params }),
    credentials: 'same-origin',
  });

  if (response.status === 401 && context.mode === 'owner' && context.refreshUrl) {
    (globalThis as BalabashGlobal).location?.assign(context.refreshUrl);

    // The page is navigating away; never settle.
    return new Promise(() => {});
  }

  const body = (await response.json().catch(() => null)) as
    | { result?: unknown; error?: { code?: string; message?: string } }
    | null;

  if (!response.ok || !body || body.error) {
    const message = body?.error?.message ?? `endpoint "${name}" failed with HTTP ${response.status}`;

    throw new Error(`balabash/data: ${message}`);
  }

  return body.result;
}
