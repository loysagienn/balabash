// Browser consent through the MCP SDK and access-token refresh for catalog
// calls. Tokens and PKCE state live in the connections table.

import crypto from 'node:crypto';
import {
  discoverOAuthServerInfo,
  refreshAuthorization,
  selectResourceURL,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientProvider, OAuthServerInfo } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { Prisma } from '../../../prisma-generated/client.ts';
import { prisma } from '../../db/client.ts';
import { getAccountService } from './services.ts';
import { config } from '../../config/index.ts';
import type { ConnectionModel } from '../../../prisma-generated/models.ts';

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// The tokens as stored on the connection row: the SDK's shape plus the
// instant they were obtained — expires_in is relative to that instant.
type StoredTokens = OAuthTokens & { obtained_at?: string };

function redirectUrl(): string {
  return `https://${config.consoleDomain}/oauth/callback`;
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

// Whether a stored client registration was obtained from the given
// authorization server. A resource server may hand its authorization to
// another server (context.avride.ai, 2026-10-26: the MCP server stopped
// proxying OAuth itself and names Avride ID directly since), and discovery
// (RFC 9728) follows the move at the next flow — but the client_id a DCR
// registration got from the former server means nothing to the new one:
// invalid_client at the consent step, where no code of ours runs to notice.
// The interactive provider stamps a registration it saves with the
// authorization server it was obtained from (authorization_server — our
// own field in the row, not part of the DCR answer); a stamp naming another
// server makes the registration stale. A registration without a stamp — one
// saved before the stamp existed, or a client the operator provisioned by
// hand — is not judged: its origin is not known, and a guess would replace
// a working client. Servers compare as issuers: a trailing slash is the one
// shape difference discovery produces (URL serializers add it to a bare
// origin), not another server.
export function registrationFromAuthorizationServer(
  info: OAuthClientInformationMixed,
  authorizationServer: string,
): boolean {
  const stamp = (info as { authorization_server?: unknown }).authorization_server;

  if (typeof stamp !== 'string') {
    return true;
  }

  return stamp.replace(/\/+$/, '') === authorizationServer.replace(/\/+$/, '');
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

// A provider may forget a dynamic client while its issuer and redirect URI
// stay the same. Discard only the registration actually refused: another
// sign-in may already have saved its replacement.
async function forgetRefusedClient(server: string, info: OAuthClientInformationMixed): Promise<void> {
  await prisma.oauthClient.deleteMany({
    where: { server, clientInformation: { equals: info as unknown as Prisma.InputJsonValue } },
  });
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
// authorizationServer is the one discovery named for this flow (the caller
// discovers it the way the SDK is about to): the registration is judged
// against it and a new registration is stamped with it. Without it the
// origin of the registration is not judged.
export function createInteractiveAuthProvider(
  connection: ConnectionModel,
  authorizationRedirect: { url: URL | null },
  authorizationServer?: string,
): OAuthClientProvider {
  let offered: OAuthClientInformationMixed | undefined;
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

      if (
        info &&
        authorizationServer !== undefined &&
        !registrationFromAuthorizationServer(info, authorizationServer)
      ) {
        console.log(
          `[oauth] the "${connection.server}" client is registered at another authorization server — registering anew at ${authorizationServer}`,
        );

        return undefined;
      }

      offered = info;
      return info;
    },
    invalidateCredentials: async scope => {
      if (offered && (scope === 'all' || scope === 'client') && getAccountService(connection.server)?.clientRegistration === 'dynamic') {
        await forgetRefusedClient(connection.server, offered);
      }
    },
    saveClientInformation: info =>
      saveClientInformation(
        connection.server,
        authorizationServer === undefined
          ? info
          : ({ ...info, authorization_server: authorizationServer } as unknown as OAuthClientInformationMixed),
      ),
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
// A failed refresh ahead of expiry is not retried for this long while the
// stored token can still go out: a transport's own 401-driven refresh runs
// right after it and must not be preceded by a second identical attempt on
// every request, and a direct call hands out the token that still lives.
const REFRESH_FAILURE_BACKOFF_MS = 30 * 1000;

function stampObtainedAt(tokens: OAuthTokens): StoredTokens {
  return { ...tokens, obtained_at: new Date().toISOString() };
}

// The instant the access token stops being good, when the tokens say it.
function expiresAt(tokens: StoredTokens): number | null {
  const obtainedAt = typeof tokens.obtained_at === 'string' ? Date.parse(tokens.obtained_at) : NaN;
  const expiresIn = Number(tokens.expires_in);

  if (Number.isNaN(obtainedAt) || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    return null;
  }

  return obtainedAt + expiresIn * 1000;
}

function isExpiringSoon(tokens: StoredTokens): boolean {
  const expiry = expiresAt(tokens);

  return expiry !== null && Date.now() >= expiry - REFRESH_LEEWAY_MS;
}

function isExpired(tokens: StoredTokens): boolean {
  const expiry = expiresAt(tokens);

  return expiry !== null && Date.now() >= expiry;
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

// The authorization of a connection is gone: there is no stored token, or
// the provider no longer honors the refresh token. Only the user's consent
// brings it back.
export class AuthorizationLostError extends Error {
  override name = 'AuthorizationLostError';
}

// The OAuth client of the installation cannot act for the service: there is
// none, or the provider refuses the client itself (a wrong client secret, a
// client deleted at the provider). No account of the service renews its
// token until the client is put right — and nothing is said by it about the
// authorization of any account.
export class OauthClientError extends Error {
  override name = 'OauthClientError';
}

// What the provider answered the exchange (RFC 6749 §5.2), as the SDK names
// the classes of its OAuth errors: a refresh token it no longer honors, a
// client it does not accept. Anything else — no answer, a server error — is
// left as it is: the authorization itself may be fine.
function refreshFailure(error: unknown): unknown {
  const name = error instanceof Error ? error.constructor.name : '';
  const said = error instanceof Error && error.message ? error.message : name;

  if (name === 'InvalidGrantError') {
    return new AuthorizationLostError(`the provider no longer honors the refresh token (${said})`);
  }

  if (name === 'InvalidClientError' || name === 'UnauthorizedClientError') {
    return new OauthClientError(`the provider refused the OAuth client of the installation (${said})`);
  }

  return error;
}

async function refreshStoredTokens(
  connection: { id: string; server: string },
  serverUrl: string,
  refreshToken: string,
): Promise<StoredTokens> {
  const info = await discoverServerInfo(serverUrl);
  const clientInformation = await loadClientInformation(connection.server);

  const dynamic = getAccountService(connection.server)?.clientRegistration === 'dynamic';
  if (!clientInformation) {
    if (dynamic) throw new AuthorizationLostError('the dynamic client is missing; a new sign-in registers it');
    throw new OauthClientError('the installation holds no OAuth client of the service');
  }

  // No provider of ours sets a rule of its own on the resource.
  const resource = await selectResourceURL(serverUrl, {} as OAuthClientProvider, info.resourceMetadata);
  let tokens: OAuthTokens;
  try {
    tokens = await refreshAuthorization(info.authorizationServerUrl, {
      metadata: info.authorizationServerMetadata, clientInformation, refreshToken, resource,
    });
  } catch (error) {
    if (dynamic && refreshFailure(error) instanceof OauthClientError) {
      await forgetRefusedClient(connection.server, clientInformation);
      throw new AuthorizationLostError('the provider refused the dynamic client; a new sign-in registers it');
    }
    throw error;
  }
  const fresh = stampObtainedAt(tokens);

  await prisma.connection.update({
    where: { id: connection.id },
    data: { tokens: fresh as unknown as Prisma.InputJsonValue },
  });

  return fresh;
}

// The one exchange of a refresh token, for a transport and for a direct call
// alike. One at a time per connection row: concurrent requests of one
// account share the attempt in flight instead of each asking the provider.
// A failure says what it means (refreshFailure) and is remembered: while the
// stored token still lives, the next request does not repeat the attempt.
const refreshesInFlight = new Map<string, Promise<StoredTokens>>();
const refreshFailedAt = new Map<string, number>();

function exchangeRefreshToken(
  connection: { id: string; server: string },
  serverUrl: string,
  refreshToken: string,
): Promise<StoredTokens> {
  let inFlight = refreshesInFlight.get(connection.id);

  if (!inFlight) {
    inFlight = refreshStoredTokens(connection, serverUrl, refreshToken)
      .then(
        fresh => {
          refreshFailedAt.delete(connection.id);

          return fresh;
        },
        error => {
          refreshFailedAt.set(connection.id, Date.now());

          throw refreshFailure(error);
        },
      )
      .finally(() => {
        refreshesInFlight.delete(connection.id);
      });
    refreshesInFlight.set(connection.id, inFlight);
  }

  return inFlight;
}

function refreshFailedLately(connectionId: string): boolean {
  const failedAt = refreshFailedAt.get(connectionId);

  return failedAt !== undefined && Date.now() - failedAt < REFRESH_FAILURE_BACKOFF_MS;
}

// The access token of a connected account for a call made straight to the
// provider's API — no MCP transport in between to refresh on a 401, so the
// token handed out is good now or the call is refused here. A token about
// to expire is renewed first; when that exchange got no answer, a token that
// still lives goes out as it is, and an expired one does not. `rejected`
// names a token the provider has just refused: the answer is a newer one —
// the stored token when another call has renewed it meanwhile, a refreshed
// one otherwise. An account that cannot act any more throws
// AuthorizationLostError, a client of the installation the provider does not
// accept — OauthClientError; an exchange the authorization server did not
// answer throws whatever it threw — the authorization itself may be fine.
export async function connectionAccessToken(
  connection: { id: string; server: string },
  serverUrl: string,
  rejected?: string,
): Promise<string> {
  const row = await prisma.connection.findUnique({
    where: { id: connection.id },
    select: { status: true, tokens: true },
  });
  const stored = row?.status === 'connected' && isObject(row.tokens) ? (row.tokens as StoredTokens) : null;

  if (!stored?.access_token) {
    throw new AuthorizationLostError('the account holds no access token');
  }

  if (rejected !== undefined) {
    if (stored.access_token !== rejected) {
      return stored.access_token;
    }

    if (!stored.refresh_token) {
      throw new AuthorizationLostError('the provider refused the access token and the account holds no refresh token');
    }

    return (await exchangeRefreshToken(connection, serverUrl, stored.refresh_token)).access_token;
  }

  if (!stored.refresh_token || !isExpiringSoon(stored)) {
    return stored.access_token;
  }

  const alive = !isExpired(stored);

  if (alive && refreshFailedLately(connection.id)) {
    return stored.access_token;
  }

  try {
    return (await exchangeRefreshToken(connection, serverUrl, stored.refresh_token)).access_token;
  } catch (error) {
    if (alive && !(error instanceof AuthorizationLostError) && !(error instanceof OauthClientError)) {
      return stored.access_token;
    }

    throw error;
  }
}
