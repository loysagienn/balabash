// OAuthClientProvider implementations for the MCP SDK (§10). Two flavours:
// the interactive provider drives a browser flow (consent URL capture, PKCE
// verifier on the connection row), the transport provider serves stored
// tokens to background MCP clients and saves refreshes, but refuses to start
// an interactive flow. Tokens and PKCE state live only in the connections
// table — never in the log (§2 ставка 4).

import crypto from 'node:crypto';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata } from '@modelcontextprotocol/sdk/shared/auth.js';
import { Prisma } from '../../../prisma-generated/client.ts';
import { prisma } from '../../db/client.ts';
import { config } from '../../config/index.ts';
import type { ConnectionModel } from '../../../prisma-generated/models.ts';

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function redirectUrl(): string {
  return `https://${config.domain}/oauth/callback`;
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
    clientInformation: () => loadClientInformation(connection.server),
    saveClientInformation: info => saveClientInformation(connection.server, info),
    tokens: () => undefined,
    saveTokens: async tokens => {
      await prisma.connection.update({
        where: { id: connection.id },
        data: {
          status: 'connected',
          tokens: tokens as unknown as Prisma.InputJsonValue,
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

// Used by background MCP transports. It serves stored tokens and saves
// refreshes, but deliberately refuses to start an interactive flow.
export function createTransportAuthProvider(serverName: string, userId: string): OAuthClientProvider {
  const getConnection = () =>
    prisma.connection.findUnique({ where: { userId_server: { userId, server: serverName } } });

  return {
    get redirectUrl() {
      return redirectUrl();
    },
    get clientMetadata() {
      return clientMetadata();
    },
    state: () => crypto.randomBytes(24).toString('base64url'),
    clientInformation: () => loadClientInformation(serverName),
    saveClientInformation: info => saveClientInformation(serverName, info),
    tokens: async () => {
      const connection = await getConnection();

      if (!connection || connection.status !== 'connected' || !isObject(connection.tokens)) {
        return undefined;
      }

      return connection.tokens as { access_token: string; token_type: string };
    },
    saveTokens: async tokens => {
      const connection = await getConnection();

      if (connection) {
        await prisma.connection.update({
          where: { id: connection.id },
          data: { tokens: tokens as unknown as Prisma.InputJsonValue },
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

      const connection = await getConnection();

      if (connection) {
        await prisma.connection.update({ where: { id: connection.id }, data: { tokens: Prisma.DbNull } });
      }
    },
  };
}
