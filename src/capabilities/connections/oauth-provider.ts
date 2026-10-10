// OAuthClientProvider implementations for the MCP SDK (§10). Two flavours:
// the interactive provider drives a browser flow (consent URL capture, PKCE
// verifier on the connection row), the transport provider serves stored
// tokens to background MCP clients, refreshes them ahead of expiry and saves
// refreshes, but refuses to start an interactive flow. Tokens and PKCE state
// live only in the connections table — never in the log (§2 ставка 4).

import crypto from 'node:crypto';
import {
  discoverOAuthServerInfo,
  refreshAuthorization,
  selectResourceURL,
  UnauthorizedError,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientProvider, OAuthServerInfo } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { Prisma } from '../../../prisma-generated/client.ts';
import { prisma } from '../../db/client.ts';
import { config } from '../../config/index.ts';
import type { ConnectionModel } from '../../../prisma-generated/models.ts';

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// The tokens as stored on the connection row: the SDK's shape plus the
// instant they were obtained — expires_in is relative to that instant.
type StoredTokens = OAuthTokens & { obtained_at?: string };

function redirectUrl(): string {
  return `https://${config.domain}/oauth/callback`;
}

// Whether a stored client registration serves the given redirect URI. A
// dynamically registered client is bound to the redirect_uris it was
// registered with (RFC 7591): the authorization server refuses a consent
// request that names another one, so a redirect URI that changed (the web
// moved to another domain) makes the stored registration useless for new
// authorizations. The row keeps the DCR answer whole, so the registration
// itself says which URIs it serves. The comparison is the one the
// authorization server makes: the SDK sends redirectUrl() as the very string
// it is (String(redirectUrl) in both the consent URL and the code exchange),
// and a server given a full redirect URI at registration compares it by
// simple string comparison (RFC 6749 §3.1.2.3) — so a registration that
// differs by anything, a :443, the case of the host, a trailing slash, is a
// registration the server would refuse, not a match. Whatever shape the
// domain has, it has it consistently: the same string is registered, stored
// and sent. A client the operator provisioned by hand carries no
// redirect_uris in the row — its redirect URI lives in the provider's own
// console — and is never judged here.
export function registrationServesRedirect(info: OAuthClientInformationMixed, redirect: string): boolean {
  const uris = (info as { redirect_uris?: unknown }).redirect_uris;

  if (!Array.isArray(uris)) {
    return true;
  }

  return uris.includes(redirect);
}

function clientMetadata(): OAuthClientMetadata {
  return {
    client_name: 'Balabash',
    redirect_uris: [redirectUrl()],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  };
}

async function loadClientInformation(server: string): Promise<OAuthClientInformationMixed | undefined> {
  const client = await prisma.oauthClient.findUnique({ where: { server } });

  return (client?.clientInformation as OAuthClientInformationMixed | null) ?? undefined;
}

// Persists the client registration obtained via DCR; manual clients are
// provisioned through the operator form into the same table.
async function saveClientInformation(server: string, info: OAuthClientInformationMixed): Promise<void> {
  const clientInformation = info as unknown as Prisma.InputJsonValue;

  await prisma.oauthClient.upsert({
    where: { server },
    create: { server, clientInformation },
    update: { clientInformation },
  });
}

// Used only by an interactive authorization flow. It captures the provider's
// consent URL and persists the PKCE verifier on the connection row.
export function createInteractiveAuthProvider(
  connection: ConnectionModel,
  authorizationRedirect: { url: URL | null },
): OAuthClientProvider {
  return {
    get redirectUrl() {
      return redirectUrl();
    },
    get clientMetadata() {
      return clientMetadata();
    },
    state: () => {
      if (!connection.pendingState) {
        throw new Error('Authorization flow has no pending state');
      }

      return connection.pendingState;
    },
    // A registration that no longer serves the current redirect URI is
    // reported as no client: the SDK registers anew (saveClientInformation
    // replaces the row), and the new client's redirect URI is the current
    // one. Connections of the replaced client keep working until their
    // refresh tokens are refused; they re-authorize then. Only the
    // interactive flow judges the registration — a background refresh does
    // not involve the redirect URI and must not replace the client.
    clientInformation: async () => {
      const info = await loadClientInformation(connection.server);

      if (info && !registrationServesRedirect(info, redirectUrl())) {
        console.log(
          `[oauth] the "${connection.server}" client is registered for another redirect URI — registering anew for ${redirectUrl()}`,
        );

        return undefined;
      }

      return info;
    },
    saveClientInformation: info => saveClientInformation(connection.server, info),
    tokens: () => undefined,
    saveTokens: async tokens => {
      await prisma.connection.update({
        where: { id: connection.id },
        data: {
          status: 'connected',
          tokens: stampObtainedAt(tokens) as unknown as Prisma.InputJsonValue,
          connectNonce: null,
          pendingState: null,
          pending: Prisma.DbNull,
          metadata: { scope: tokens.scope ?? null },
        },
      });
    },
    redirectToAuthorization: url => {
      authorizationRedirect.url = url;
    },
    saveCodeVerifier: async codeVerifier => {
      const pending = { ...(isObject(connection.pending) ? connection.pending : {}), codeVerifier };

      connection.pending = pending;
      await prisma.connection.update({ where: { id: connection.id }, data: { pending } });
    },
    codeVerifier: () => {
      const codeVerifier = isObject(connection.pending) ? connection.pending.codeVerifier : undefined;

      if (typeof codeVerifier !== 'string') {
        throw new Error('Authorization flow has no stored PKCE code verifier');
      }

      return codeVerifier;
    },
  };
}

// ---------------------------------------------------------------------------
// Proactive refresh. The SDK refreshes only when the resource server answers
// 401 — a check that happens at call time, by a server asking the provider
// whether the token is still good. That check can fail open (network) or
// race the expiry by a second, and then an expired token reaches the API and
// the 401 comes back inside a tool result, where no refresh ever happens
// (gmail, 2026-09-22 and 2026-09-29). The provider knows the lifetime from
// expires_in and the instant the tokens were saved, so it refreshes before
// expiry itself; the server-side 401 stays as the safety net (and as the
// path through which a dead refresh token still ends in re-authorization).
// ---------------------------------------------------------------------------

// Refresh this long before the access token actually expires.
const REFRESH_LEEWAY_MS = 60 * 1000;
// A failed proactive refresh is not retried for this long: the SDK's own
// 401-driven refresh runs right after it and must not be preceded by a
// second identical attempt on every request.
const REFRESH_FAILURE_BACKOFF_MS = 30 * 1000;

function stampObtainedAt(tokens: OAuthTokens): StoredTokens {
  return { ...tokens, obtained_at: new Date().toISOString() };
}

function isExpiringSoon(tokens: StoredTokens): boolean {
  const obtainedAt = typeof tokens.obtained_at === 'string' ? Date.parse(tokens.obtained_at) : NaN;
  const expiresIn = Number(tokens.expires_in);

  if (Number.isNaN(obtainedAt) || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    return false;
  }

  return Date.now() >= obtainedAt + expiresIn * 1000 - REFRESH_LEEWAY_MS;
}

// Authorization server discovery per resource server url, once per process:
// the metadata is static and the discovery costs two network round-trips.
const discoveryCache = new Map<string, Promise<OAuthServerInfo>>();

function discoverServerInfo(serverUrl: string): Promise<OAuthServerInfo> {
  let pending = discoveryCache.get(serverUrl);

  if (!pending) {
    pending = discoverOAuthServerInfo(serverUrl).catch(error => {
      discoveryCache.delete(serverUrl);
      throw error;
    });
    discoveryCache.set(serverUrl, pending);
  }

  return pending;
}

// One refresh at a time per connection row: concurrent requests of one
// account share the in-flight attempt instead of each asking the provider.
const refreshesInFlight = new Map<string, Promise<StoredTokens>>();
const refreshFailedAt = new Map<string, number>();

async function refreshStoredTokens(
  connection: { id: string; server: string },
  serverUrl: string,
  provider: OAuthClientProvider,
  refreshToken: string,
): Promise<StoredTokens> {
  const info = await discoverServerInfo(serverUrl);
  const clientInformation = await loadClientInformation(connection.server);

  if (!clientInformation) {
    throw new Error('no OAuth client information');
  }

  const resource = await selectResourceURL(serverUrl, provider, info.resourceMetadata);
  const fresh = stampObtainedAt(
    await refreshAuthorization(info.authorizationServerUrl, {
      metadata: info.authorizationServerMetadata,
      clientInformation,
      refreshToken,
      resource,
    }),
  );

  await prisma.connection.update({
    where: { id: connection.id },
    data: { tokens: fresh as unknown as Prisma.InputJsonValue },
  });

  return fresh;
}

// Used by background MCP transports. It serves stored tokens (refreshing
// them ahead of expiry) and saves the SDK's own refreshes, but deliberately
// refuses to start an interactive flow. Addressed by connection row id: one
// provider serves exactly one account's tokens. serverUrl is the resource
// server the tokens are for — the anchor of authorization server discovery.
export function createTransportAuthProvider(
  connection: { id: string; server: string },
  serverUrl: string,
): OAuthClientProvider {
  const getConnection = () => prisma.connection.findUnique({ where: { id: connection.id } });

  const provider: OAuthClientProvider = {
    get redirectUrl() {
      return redirectUrl();
    },
    get clientMetadata() {
      return clientMetadata();
    },
    state: () => crypto.randomBytes(24).toString('base64url'),
    clientInformation: () => loadClientInformation(connection.server),
    saveClientInformation: info => saveClientInformation(connection.server, info),
    tokens: async () => {
      const row = await getConnection();

      if (!row || row.status !== 'connected' || !isObject(row.tokens)) {
        return undefined;
      }

      const stored = row.tokens as StoredTokens;

      if (!stored.refresh_token || !isExpiringSoon(stored)) {
        return stored;
      }

      const failedAt = refreshFailedAt.get(connection.id);

      if (failedAt !== undefined && Date.now() - failedAt < REFRESH_FAILURE_BACKOFF_MS) {
        return stored;
      }

      let inFlight = refreshesInFlight.get(connection.id);

      if (!inFlight) {
        inFlight = refreshStoredTokens(connection, serverUrl, provider, stored.refresh_token).finally(() => {
          refreshesInFlight.delete(connection.id);
        });
        refreshesInFlight.set(connection.id, inFlight);
      }

      try {
        const fresh = await inFlight;

        refreshFailedAt.delete(connection.id);
        console.log(`[oauth] refreshed "${connection.server}" tokens ahead of expiry (connection ${connection.id})`);

        return fresh;
      } catch (error) {
        // The stored tokens go out as they are: the resource server's 401
        // hands the SDK its own refresh attempt, and a refresh token the
        // provider no longer honors ends in re-authorization there.
        refreshFailedAt.set(connection.id, Date.now());
        console.warn(
          `[oauth] proactive refresh of "${connection.server}" tokens failed (connection ${connection.id}): ${error instanceof Error ? error.message : String(error)}`,
        );

        return stored;
      }
    },
    saveTokens: async tokens => {
      const row = await getConnection();

      if (row) {
        await prisma.connection.update({
          where: { id: row.id },
          data: { tokens: stampObtainedAt(tokens) as unknown as Prisma.InputJsonValue },
        });
      }
    },
    redirectToAuthorization: () => {
      throw new UnauthorizedError('User authorization is required');
    },
    saveCodeVerifier: () => {},
    codeVerifier: () => {
      throw new Error('Background connection cannot run an authorization flow');
    },
    invalidateCredentials: async scope => {
      if (scope !== 'all' && scope !== 'tokens') {
        return;
      }

      const row = await getConnection();

      if (row) {
        await prisma.connection.update({ where: { id: row.id }, data: { tokens: Prisma.DbNull } });
      }
    },
  };

  return provider;
}
