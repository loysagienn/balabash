// The Google plumbing shared by the in-process Google tool servers (gmail,
// drive). Each of them is an OAuth protected resource of the same shape: its
// metadata points at accounts.google.com, the Balabash runtime runs the
// whole OAuth flow (consent link, PKCE, callback, token storage, refresh),
// and every incoming /mcp request carries the user's Google access token as
// a Bearer header. The token is used directly against the Google API and is
// never kept in module state — each request gets its own McpServer bound to
// that token. What differs per server is the API it talks to and the tools
// it registers; what is here is the rest: the loopback HTTP endpoint with
// its RFC 9728 metadata, the bearer check against tokeninfo, and the fetch
// that surfaces Google's own diagnostics.

import crypto from 'node:crypto';
import http from 'node:http';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

export const GOOGLE_AUTHORIZATION_SERVER = 'https://accounts.google.com';
const TOKENINFO_URL = 'https://oauth2.googleapis.com/tokeninfo';

// The calling run's identity rides in the MCP request _meta (set by the tool
// manager for local servers). A stored file must belong to that workspace —
// an ownerless file cannot be delivered back to the user.
export function callerWorkspaceId(extra: { _meta?: Record<string, unknown> }): string | null {
  const balabash = extra._meta?.balabash;
  const workspaceId =
    balabash && typeof balabash === 'object' && !Array.isArray(balabash)
      ? (balabash as Record<string, unknown>).workspaceId
      : undefined;

  return typeof workspaceId === 'string' && workspaceId ? workspaceId : null;
}

// ---------------------------------------------------------------------------
// Google REST: one fetch that reads Google's error body
// ---------------------------------------------------------------------------

export class GoogleApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export type GoogleApi = {
  // The API's name in error messages ("Gmail API 404 on GET /messages/…").
  name: string;
  // What a 403 most likely means for this API (API not enabled, scope).
  forbiddenHint: string;
};

export type GoogleRequestInit = {
  method?: string;
  // A JSON body (serialized here) — or a raw body with its content type.
  json?: unknown;
  body?: Buffer | string;
  contentType?: string;
  headers?: Record<string, string>;
  accept?: string;
};

const UNAUTHORIZED_HINT =
  ' The Google access token expired or was rejected; Balabash refreshes it on the next call — retry once. Ask the user to re-authorize via request_authorization only if the 401 persists across retries.';

// The response of a Google API call, checked: a non-2xx answer becomes a
// GoogleApiError carrying Google's own diagnostics verbatim — a bare status
// code has already caused wrong blind diagnoses in this installation. The
// caller reads the body (JSON, bytes, a stream) as it needs.
export async function googleRequest(api: GoogleApi, accessToken: string, url: string, init: GoogleRequestInit = {}): Promise<Response> {
  const method = init.method ?? 'GET';
  const hasJson = init.json !== undefined;
  const response = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: init.accept ?? 'application/json',
      ...(hasJson ? { 'content-type': 'application/json' } : init.contentType ? { 'content-type': init.contentType } : {}),
      ...(init.headers ?? {}),
    },
    body: hasJson ? JSON.stringify(init.json) : init.body,
  });

  if (response.ok) {
    return response;
  }

  const text = await response.text().catch(() => '');
  let detail = text.slice(0, 1_000);

  try {
    const parsed = JSON.parse(text) as { error?: { status?: string; message?: string } | string; error_description?: string };

    if (parsed?.error && typeof parsed.error === 'object' && parsed.error.message) {
      detail = `${parsed.error.status ? `${parsed.error.status}: ` : ''}${parsed.error.message}`;
    } else if (typeof parsed?.error === 'string') {
      detail = parsed.error_description ? `${parsed.error}: ${parsed.error_description}` : parsed.error;
    }
  } catch {
    // Keep the raw body.
  }

  if (response.status === 401) {
    // Whatever the gate believed about this token, Google has the last word:
    // forget the cached verdict so the next request re-validates (and lets
    // the Balabash client refresh the token).
    forgetTokenValidity(accessToken);
  }

  const hint = response.status === 401 ? UNAUTHORIZED_HINT : response.status === 403 ? ` ${api.forbiddenHint}` : '';
  const path = new URL(url).pathname;

  throw new GoogleApiError(`${api.name} ${response.status} on ${method} ${path}: ${detail}${hint}`, response.status);
}

// A JSON-answering call: the parsed object, {} for an empty body.
export async function googleJson(api: GoogleApi, accessToken: string, url: string, init: GoogleRequestInit = {}): Promise<Record<string, unknown>> {
  const response = await googleRequest(api, accessToken, url, init);
  const text = await response.text();

  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

// ---------------------------------------------------------------------------
// Bearer token validation (Google tokeninfo, short-lived cache)
// ---------------------------------------------------------------------------

// Cache keyed by token hash so no token value sits in module state. An entry
// only records "this token was valid until T". Shared by every Google server
// of the process: a token is a token, whichever API it was issued for.
const tokenValidityCache = new Map<string, number>();
const TOKEN_CACHE_MAX_TTL_MS = 10 * 60 * 1000;
const TOKEN_CACHE_SAFETY_MS = 30 * 1000;
const TOKEN_CACHE_MAX_ENTRIES = 500;

function pruneTokenCache(): void {
  const now = Date.now();

  for (const [key, validUntil] of tokenValidityCache) {
    if (validUntil <= now) {
      tokenValidityCache.delete(key);
    }
  }

  while (tokenValidityCache.size > TOKEN_CACHE_MAX_ENTRIES) {
    const oldest = tokenValidityCache.keys().next().value;

    if (oldest === undefined) {
      break;
    }

    tokenValidityCache.delete(oldest);
  }
}

function tokenCacheKey(accessToken: string): string {
  return crypto.createHash('sha256').update(accessToken).digest('base64');
}

export function forgetTokenValidity(accessToken: string): void {
  tokenValidityCache.delete(tokenCacheKey(accessToken));
}

async function isAccessTokenValid(serverName: string, accessToken: string): Promise<boolean> {
  const key = tokenCacheKey(accessToken);
  const cached = tokenValidityCache.get(key);

  if (cached !== undefined && cached > Date.now()) {
    return true;
  }

  let response: Response;

  try {
    response = await fetch(TOKENINFO_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ access_token: accessToken }),
    });
  } catch (error) {
    // tokeninfo unreachable: fail open — if the token is actually bad, the
    // API call itself will report it clearly. Loudly: a silent pass here
    // once turned a one-off network hiccup into a blind re-authorization.
    console.warn(
      `[${serverName}] tokeninfo unreachable, letting the request through unverified: ${error instanceof Error ? error.message : String(error)}`,
    );

    return true;
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => {});

    return false;
  }

  const info = (await response.json().catch(() => ({}))) as { expires_in?: string | number };
  const expiresInMs = Number(info.expires_in ?? 0) * 1000;
  const ttl = Math.min(expiresInMs - TOKEN_CACHE_SAFETY_MS, TOKEN_CACHE_MAX_TTL_MS);

  if (ttl > 0) {
    pruneTokenCache();
    tokenValidityCache.set(key, Date.now() + ttl);
  }

  return true;
}

// ---------------------------------------------------------------------------
// HTTP endpoint: protected-resource metadata + authenticated /mcp
// ---------------------------------------------------------------------------

async function readJsonBody(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const body = Buffer.concat(chunks).toString('utf8');

  return body ? JSON.parse(body) : undefined;
}

function sendJson(response: http.ServerResponse, status: number, payload: unknown, headers?: Record<string, string>): void {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(JSON.stringify(payload));
}

function sendUnauthorized(response: http.ServerResponse, origin: string, description: string): void {
  sendJson(
    response,
    401,
    { error: 'invalid_token', error_description: description },
    {
      'www-authenticate':
        `Bearer error="invalid_token", error_description="${description}", ` +
        `resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
    },
  );
}

// Serves one Google-protected MCP endpoint on loopback: the RFC 9728
// metadata naming Google as the authorization server, and POST /mcp, which
// checks the bearer token and hands the request to a fresh McpServer bound
// to that token. Returns the endpoint url for the server's config.
export async function serveGoogleMcp(options: {
  serverName: string;
  scopes: string[];
  createMcpServer: (accessToken: string) => McpServer;
}): Promise<{ url: string; close: () => Promise<void> }> {
  const httpServer = http.createServer(async (request, response) => {
    const origin = `http://${request.headers.host ?? '127.0.0.1'}`;
    const pathname = new URL(request.url ?? '/', origin).pathname;

    // RFC 9728 protected resource metadata: tells the Balabash OAuth client
    // that the authorization server for this resource is Google. Both the
    // path-aware and the root well-known locations are served.
    if (
      request.method === 'GET' &&
      (pathname === '/.well-known/oauth-protected-resource/mcp' || pathname === '/.well-known/oauth-protected-resource')
    ) {
      sendJson(response, 200, {
        resource: `${origin}/mcp`,
        authorization_servers: [GOOGLE_AUTHORIZATION_SERVER],
        scopes_supported: options.scopes,
        bearer_methods_supported: ['header'],
      });
      return;
    }

    if (pathname !== '/mcp' || request.method !== 'POST') {
      sendJson(response, 405, {
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed.' },
        id: null,
      });
      return;
    }

    const bearerMatch = /^Bearer\s+(.+)$/i.exec(request.headers.authorization ?? '');
    const accessToken = bearerMatch?.[1]?.trim();

    if (!accessToken) {
      sendUnauthorized(response, origin, 'Missing bearer token');
      return;
    }

    if (!(await isAccessTokenValid(options.serverName, accessToken))) {
      // An expired access token: the 401 makes the Balabash MCP client
      // refresh it with the stored refresh token and retry transparently.
      sendUnauthorized(response, origin, 'Google access token is invalid or expired');
      return;
    }

    const server = options.createMcpServer(accessToken);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    try {
      const body = await readJsonBody(request);

      await server.connect(transport);
      await transport.handleRequest(request, response, body);
    } catch (error) {
      if (!response.headersSent) {
        sendJson(response, 500, {
          jsonrpc: '2.0',
          error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
          id: null,
        });
      }
    } finally {
      await transport.close().catch(() => {});
      await server.close().catch(() => {});
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', () => {
      httpServer.off('error', reject);
      resolve();
    });
  });

  const address = httpServer.address();

  if (!address || typeof address === 'string') {
    await new Promise<void>(resolve => httpServer.close(() => resolve()));
    throw new Error('Local MCP server did not receive a TCP port');
  }

  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        httpServer.close(error => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      }),
  };
}

// Google only issues a refresh token for offline access, and only reliably
// on a consent-prompted flow; without these the connection dies as soon as
// the first access token expires.
export const GOOGLE_AUTHORIZATION_PARAMS = {
  access_type: 'offline',
  prompt: 'consent',
};
