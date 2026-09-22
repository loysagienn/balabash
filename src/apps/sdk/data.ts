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
  /**
   * URL base of the app's own pages, no trailing slash: '/apps/<path>' in
   * owner mode, '/<slug>' in public mode. A pathname router must treat it as
   * its prefix — the same app is served under both.
   */
  appBase: string;
  /** URL base of the app's endpoint calls, no trailing slash. */
  apiBase: string;
  /** Workspace path of the app (owner mode). */
  appPath?: string;
  /** Public slug (public mode). */
  slug?: string;
  /**
   * Owner mode: the main-domain URL of the app root; the cookie refresh
   * sends the browser to the current in-app location resolved against it.
   */
  refreshUrl?: string;
};

type BalabashGlobal = {
  __BALABASH_APP__?: AppContext;
  location?: { pathname: string; search: string; hash: string; assign(url: string): void };
};

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
    const location = (globalThis as BalabashGlobal).location;

    // The refresh keeps the user's place: the pathname is the same on both
    // domains (/apps/<path>/…), the handoff carries path and query, the
    // browser carries the fragment across the redirects.
    const target = location
      ? new URL(location.pathname + location.search + location.hash, context.refreshUrl).toString()
      : context.refreshUrl;

    location?.assign(target);

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
