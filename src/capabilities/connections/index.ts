// Per-user authorization for external MCP servers with auth: "user" (§10).
//
// A capability config registers the server once for everyone; each user then
// connects their own account through a one-time link issued by the auth
// agent. The pieces:
// - requestAuthorization issues the link (auth-agent tool, §7.4 consent);
// - GET /connect/<server>?nonce=… runs OAuth discovery (plus DCR when the
//   provider supports it) and redirects to the consent page;
// - GET /oauth/callback exchanges the code for tokens.
// Tokens live in the connections table; the log only sees sanitized
// connection.* lifecycle events addressed to the initiating thread (§4.2) —
// append redirects them to the main thread when that thread is gone (§4.3).

import crypto from 'node:crypto';
import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import { prisma } from '../../db/client.ts';
import type { JsonObject } from '../../core/contract.ts';
import { appendEvent } from '../../core/append.ts';
import {
  CONNECTION_COMPLETED,
  CONNECTION_FAILED,
  CONNECTION_REAUTHORIZATION_REQUIRED,
  OAUTH_CLIENT_PROVISIONED,
} from '../../core/envelope.ts';
import { config } from '../../config/index.ts';
import { dropUserClient, getUserAuthServer, type UserAuthServer } from '../tool-manager.ts';
import { createInteractiveAuthProvider } from './oauth-provider.ts';

export { createTransportAuthProvider } from './oauth-provider.ts';

// The link survives Telegram preview fetches and stray clicks: it stays valid
// until this TTL or a completed authorization, whichever comes first. Each
// click just restarts the flow with a fresh OAuth state.
const CONNECT_LINK_TTL_MS = 15 * 60 * 1000;
const OAUTH_CLIENT_LINK_TTL_MS = 15 * 60 * 1000;

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function randomToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}

function getServer(serverName: string): UserAuthServer {
  const server = getUserAuthServer(serverName);

  if (!server) {
    throw new Error(`Unknown integration "${serverName}"`);
  }

  return server;
}

export async function getOauthClient(serverName: string): Promise<Record<string, unknown> | null> {
  const row = await prisma.oauthClient.findUnique({ where: { server: serverName } });

  return (row?.clientInformation as Record<string, unknown> | null) ?? null;
}

async function requireManualOauthClient(server: UserAuthServer): Promise<void> {
  if (server.clientRegistration !== 'manual') {
    return;
  }

  if (!(await getOauthClient(server.name))) {
    throw new Error(
      `Integration "${server.name}" needs installation OAuth client credentials before user authorization`,
    );
  }
}

export async function listUserConnections(userId: string) {
  return prisma.connection.findMany({ where: { userId } });
}

// Issues a one-time authorization link. threadId is the issuing thread (the
// auth agent's): the flow's connection.* events are addressed to it.
export async function requestAuthorization(userId: string, threadId: string, serverName: string): Promise<string> {
  const server = getServer(serverName);

  await requireManualOauthClient(server);

  const connectNonce = randomToken();
  const pending = { expiresAt: new Date(Date.now() + CONNECT_LINK_TTL_MS).toISOString() };
  const existing = await prisma.connection.findUnique({
    where: { userId_server: { userId, server: server.name } },
  });

  if (existing) {
    await prisma.connection.update({
      where: { id: existing.id },
      data: {
        threadId,
        connectNonce,
        pendingState: null,
        pending,
        // A connected user may re-authorize; their status only changes when
        // the new flow completes.
        ...(existing.status === 'connected' ? {} : { status: 'pending' }),
      },
    });
  } else {
    await prisma.connection.create({
      data: { userId, threadId, server: server.name, status: 'pending', connectNonce, pending },
    });
  }

  return `https://${config.domain}/connect/${server.name}?nonce=${connectNonce}`;
}

// Issues an operator-only link for storing a manual installation OAuth client
// directly in the database. Submitted values never enter the event log.
export async function requestOauthClientCredentials(
  userId: string,
  threadId: string,
  serverName: string,
): Promise<string> {
  const server = getServer(serverName);

  if (server.clientRegistration !== 'manual') {
    throw new Error(`Integration "${server.name}" uses Dynamic Client Registration`);
  }

  const nonce = randomToken();
  const expiresAt = new Date(Date.now() + OAUTH_CLIENT_LINK_TTL_MS);

  await prisma.oauthClientRequest.upsert({
    where: { userId_server: { userId, server: server.name } },
    create: { userId, threadId, server: server.name, nonce, expiresAt },
    update: { threadId, nonce, expiresAt },
  });

  return `https://${config.domain}/oauth-client/${server.name}?nonce=${nonce}`;
}

export type OauthClientRequestView = {
  server: string;
  nonce: string;
};

export async function getOauthClientRequest(serverName: string, nonce: string): Promise<OauthClientRequestView> {
  const server = getServer(serverName);

  if (server.clientRegistration !== 'manual' || !nonce) {
    throw new Error('OAuth client provisioning link is malformed');
  }

  const row = await prisma.oauthClientRequest.findUnique({ where: { nonce } });

  if (!row || row.server !== server.name) {
    throw new Error('OAuth client provisioning link is invalid or already used');
  }

  if (row.expiresAt.getTime() < Date.now()) {
    throw new Error('OAuth client provisioning link has expired — ask for a new one in the chat');
  }

  return { server: row.server, nonce: row.nonce };
}

export async function provisionOauthClient(
  serverName: string,
  nonce: string,
  clientId: string,
  clientSecret: string,
): Promise<void> {
  const request = await getOauthClientRequest(serverName, nonce);
  const normalizedClientId = clientId.trim();
  const normalizedClientSecret = clientSecret.trim();

  if (!normalizedClientId) {
    throw new Error('Client ID is required');
  }

  // Consume atomically: the request row dies with the client landing.
  const consumed = await prisma.$transaction(async tx => {
    const row = await tx.oauthClientRequest.findUnique({ where: { nonce: request.nonce } });

    if (!row) {
      throw new Error('OAuth client provisioning link is invalid or already used');
    }

    await tx.oauthClientRequest.delete({ where: { id: row.id } });

    const clientInformation = {
      client_id: normalizedClientId,
      ...(normalizedClientSecret ? { client_secret: normalizedClientSecret } : {}),
    };

    await tx.oauthClient.upsert({
      where: { server: row.server },
      create: { server: row.server, clientInformation },
      update: { clientInformation },
    });

    return row;
  });

  // Sanitized fact for the log: field names only (§2 ставка 4).
  await appendEvent({
    type: OAUTH_CLIENT_PROVISIONED,
    actor: 'system',
    userId: consumed.userId,
    threadId: null,
    targetThreadId: consumed.threadId,
    payload: {
      server: consumed.server,
      fields: normalizedClientSecret ? ['client_id', 'client_secret'] : ['client_id'],
    },
  }).catch(error => {
    console.error(`[connections] failed to journal oauth client provisioning for "${consumed.server}":`, error);
  });
}

// Handles a click on the one-time link: runs OAuth discovery (and dynamic
// client registration when needed) and returns the provider's consent URL to
// redirect the browser to.
export async function handleConnectClick(serverName: string, nonce: string): Promise<string> {
  const server = getServer(serverName);

  if (!nonce) {
    throw new Error('Authorization link is malformed');
  }

  const row = await prisma.connection.findUnique({ where: { connectNonce: nonce } });

  if (!row || row.server !== server.name) {
    throw new Error('Authorization link is invalid or already used');
  }

  const pending = isObject(row.pending) ? row.pending : {};

  if (typeof pending.expiresAt !== 'string' || Date.parse(pending.expiresAt) < Date.now()) {
    throw new Error('Authorization link has expired — ask for a new one in the chat');
  }

  const pendingState = randomToken();

  row.pendingState = pendingState;
  await prisma.connection.update({ where: { id: row.id }, data: { pendingState } });

  const capture: { url: URL | null } = { url: null };
  const result = await auth(createInteractiveAuthProvider(row, capture), {
    serverUrl: server.url,
    ...(server.scope ? { scope: server.scope } : {}),
  });

  if (result !== 'REDIRECT' || !capture.url) {
    throw new Error(`Authorization flow returned unexpected result "${result}"`);
  }

  for (const [key, value] of Object.entries(server.authorizationParams ?? {})) {
    capture.url.searchParams.set(key, value);
  }

  return capture.url.toString();
}

export type OauthCallbackResult = { ok: boolean; server?: string; error?: string };

// Handles the provider redirect: exchanges the code for tokens, marks the
// connection as connected, and mirrors the outcome into the log — addressed
// to the thread that issued the link, which may be long gone by now; append
// redirects to the main thread then (§4.3).
export async function handleOauthCallback(query: Record<string, unknown>): Promise<OauthCallbackResult> {
  const state = typeof query.state === 'string' ? query.state : '';
  const code = typeof query.code === 'string' ? query.code : '';
  const providerError = typeof query.error === 'string' ? query.error : '';
  const row = state ? await prisma.connection.findUnique({ where: { pendingState: state } }) : null;

  if (!row) {
    return { ok: false, error: 'Unknown or expired authorization state' };
  }

  const journal = async (type: string, payload: JsonObject) => {
    await appendEvent({
      type,
      actor: 'system',
      userId: row.userId,
      threadId: null,
      targetThreadId: row.threadId,
      payload,
    }).catch(error => {
      console.error(`[connections] failed to journal ${type} for "${row.server}":`, error);
    });
  };

  const fail = async (error: string): Promise<OauthCallbackResult> => {
    await prisma.connection.update({ where: { id: row.id }, data: { pendingState: null } });
    await journal(CONNECTION_FAILED, { server: row.server, error });

    return { ok: false, error };
  };

  if (providerError) {
    const description = typeof query.error_description === 'string' ? `: ${query.error_description}` : '';

    return fail(`${providerError}${description}`);
  }

  if (!code) {
    return fail('Authorization response contains no code');
  }

  let server: UserAuthServer;

  try {
    server = getServer(row.server);
  } catch (error) {
    return fail(getErrorMessage(error));
  }

  try {
    const capture: { url: URL | null } = { url: null };
    const result = await auth(createInteractiveAuthProvider(row, capture), {
      serverUrl: server.url,
      authorizationCode: code,
    });

    if (result !== 'AUTHORIZED') {
      return fail(`Authorization flow returned unexpected result "${result}"`);
    }
  } catch (error) {
    return fail(getErrorMessage(error));
  }

  // A stale client may exist after re-authorization; the next turn reconnects
  // with the fresh tokens.
  dropUserClient(row.server, row.userId);

  await journal(CONNECTION_COMPLETED, { server: row.server });

  return { ok: true, server: row.server };
}

// Marks a previously connected integration as needing reauthorization. Only
// the connected → reauthorization_required transition emits an event, so a
// repeatedly failing connect cannot flood the log.
export async function markReauthorizationRequired(serverName: string, userId: string, error: string): Promise<void> {
  const row = await prisma.connection.findUnique({ where: { userId_server: { userId, server: serverName } } });

  if (!row || row.status !== 'connected') {
    return;
  }

  await prisma.connection.update({ where: { id: row.id }, data: { status: 'reauthorization_required' } });
  await appendEvent({
    type: CONNECTION_REAUTHORIZATION_REQUIRED,
    actor: 'system',
    userId,
    threadId: null,
    targetThreadId: row.threadId,
    payload: { server: serverName, error },
  }).catch(appendError => {
    console.error(`[connections] failed to journal reauthorization for "${serverName}":`, appendError);
  });
}
