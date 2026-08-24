// Per-user authorization for external MCP servers with auth: "user".
//
// A capability config registers the server once for everyone; each user then
// connects their own account through a one-time link issued by the auth
// agent. The pieces:
// - requestAuthorization issues the link (auth-agent tool);
// - GET /connect/<server>?nonce=… runs OAuth discovery (plus DCR when the
//   provider supports it) and redirects to the consent page;
// - GET /oauth/callback exchanges the code for tokens.
// Tokens live in the connections table; the log only sees sanitized
// connection.* lifecycle events addressed to the initiating thread (§4.2) —
// append redirects them to the main thread when that thread is gone (§4.3).

import crypto from 'node:crypto';
import { auth } from '@modelcontextprotocol/sdk/client/auth.js';
import { Prisma } from '../../../prisma-generated/client.ts';
import type { ConnectionModel } from '../../../prisma-generated/models.ts';
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
import { backfillConnectionIdentity, getAccessToken, identityData, identityLabel, probeIdentity } from './identity.ts';
import type { ProbedIdentity } from './identity.ts';
import type { IdentityProbeConfig } from '../server-config.ts';

export { createTransportAuthProvider } from './oauth-provider.ts';

// Account slugs are immutable mnemonic addresses; the pattern keeps them
// url- and enum-friendly.
export const ACCOUNT_KEY_PATTERN = /^[a-z][a-z0-9-]*$/;

// The link survives Telegram preview fetches and stray clicks: it stays valid
// until this TTL or a completed authorization, whichever comes first. Each
// click just restarts the flow with a fresh OAuth state.
const CONNECT_LINK_TTL_MS = 15 * 60 * 1000;

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

// Ordered by birth: the oldest account of a server is deterministically its
// canonical one in the client registry — never Postgres plan roulette.
export async function listUserConnections(userId: string) {
  return prisma.connection.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
}

async function requireConnection(userId: string, serverName: string, accountKey: string): Promise<ConnectionModel> {
  const row = await prisma.connection.findUnique({
    where: { userId_server_accountKey: { userId, server: serverName, accountKey } },
  });

  if (!row) {
    const rows = await prisma.connection.findMany({ where: { userId, server: serverName } });
    const known = rows.map(candidate => `${candidate.accountKey} — "${candidate.displayName}"`).join('; ') || '(none)';

    throw new Error(`No account "${accountKey}" of "${serverName}". Accounts: ${known}`);
  }

  return row;
}

// Renames the display name of one account. The slug (the address) and the
// provider identity never change.
export async function renameConnection(
  userId: string,
  serverName: string,
  accountKey: string,
  name: string,
): Promise<{ accountKey: string; previousName: string; name: string }> {
  const row = await requireConnection(userId, serverName, accountKey);
  const trimmed = name.trim();

  if (!trimmed) {
    throw new Error('The new name must not be empty');
  }

  // Case-insensitive, matching the name check at connect time.
  const clash = await prisma.connection.findFirst({
    where: { userId, server: serverName, displayName: { equals: trimmed, mode: 'insensitive' }, NOT: { id: row.id } },
  });

  if (clash) {
    throw new Error(`Name "${trimmed}" is already used by account "${clash.accountKey}" of "${serverName}"`);
  }

  await prisma.connection.update({ where: { id: row.id }, data: { displayName: trimmed } });

  return { accountKey: row.accountKey, previousName: row.displayName, name: trimmed };
}

// Disconnects one account: the row dies, its live client is dropped, the
// slug becomes free. Tokens go with the row; access at the provider side is
// revoked by the user in the provider's own UI.
export async function disconnectConnection(
  userId: string,
  serverName: string,
  accountKey: string,
): Promise<{ accountKey: string; name: string }> {
  const row = await requireConnection(userId, serverName, accountKey);

  await prisma.connection.delete({ where: { id: row.id } });
  dropUserClient(row.server, userId, row.accountKey);

  return { accountKey: row.accountKey, name: row.displayName };
}

// Issues a one-time authorization link for one account of the service.
// threadId is the issuing thread (the auth agent's): the flow's connection.*
// events are addressed to it. Passing an unknown accountKey starts a new
// account — gated on the service declaring an identity probe and on every
// existing account's identity being known (else the twin guard is blind).
export async function requestAuthorization(
  userId: string,
  threadId: string,
  serverName: string,
  requestedAccountKey?: string,
  displayName?: string,
): Promise<string> {
  const server = getServer(serverName);

  await requireManualOauthClient(server);

  const accountKey = requestedAccountKey ?? 'default';

  if (!ACCOUNT_KEY_PATTERN.test(accountKey)) {
    throw new Error(`Account key "${accountKey}" must match ${ACCOUNT_KEY_PATTERN}`);
  }

  const rows = await prisma.connection.findMany({ where: { userId, server: server.name } });
  const existing = rows.find(row => row.accountKey === accountKey) ?? null;

  // The multiplicity gate.
  if (!existing && rows.length) {
    if (!server.identityProbe) {
      throw new Error(
        `Integration "${server.name}" declares no identity probe, so it holds at most one connected account`,
      );
    }

    for (const row of rows) {
      if (row.identityId) {
        continue;
      }

      // A row with no stored tokens holds no provider account (an abandoned
      // link, a cleared re-auth) — there is nothing for a twin to hide
      // behind; the callback's twin check covers it if it ever completes.
      if (!getAccessToken(row.tokens)) {
        continue;
      }

      const backfill = await backfillConnectionIdentity(server.identityProbe, row.id);

      if (!backfill.ok) {
        throw new Error(
          `Cannot add another "${server.name}" account yet: the identity of account "${row.accountKey}" is unknown (${backfill.reason}). Use that account once (a live call refreshes its token and records the identity), or re-authorize it, then retry.`,
        );
      }
    }
  }

  const connectNonce = randomToken();
  const pending = { expiresAt: new Date(Date.now() + CONNECT_LINK_TTL_MS).toISOString() };

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
      data: {
        userId,
        threadId,
        server: server.name,
        accountKey,
        // Proper naming at birth arrives with the lifecycle verbs; until then
        // the display name falls back to the address.
        displayName: displayName?.trim() || (accountKey === 'default' ? server.name : accountKey),
        status: 'pending',
        connectNonce,
        pending,
      },
    });
  }

  return `https://${config.domain}/connect/${server.name}?nonce=${connectNonce}`;
}

// Records a pending request for a manual installation OAuth client and
// returns the operator's link into the web interface (session-gated page;
// the id is an address, not a credential — ownership is checked at the API
// edge). No TTL: the request lives until fulfilled or replaced. Submitted
// values never enter the event log.
export async function requestOauthClientCredentials(
  userId: string,
  threadId: string,
  serverName: string,
): Promise<string> {
  const server = getServer(serverName);

  if (server.clientRegistration !== 'manual') {
    throw new Error(`Integration "${server.name}" uses Dynamic Client Registration`);
  }

  // nonce/expiresAt are vestigial: the session flow never reads them. They
  // stay written (columns are required) until a later cleanup migration.
  const vestigial = { nonce: randomToken(), expiresAt: new Date() };

  const row = await prisma.oauthClientRequest.upsert({
    where: { userId_server: { userId, server: server.name } },
    create: { userId, threadId, server: server.name, ...vestigial },
    update: { threadId, ...vestigial },
  });

  return `https://${config.domain}/secrets/${row.id}`;
}

export type OauthClientRequestView = {
  id: string;
  server: string;
};

// Metadata only, session-derived userId; foreign or missing → null (the
// caller's 404). The server config is deliberately not consulted here.
export async function getOauthClientRequest(userId: string, requestId: string): Promise<OauthClientRequestView | null> {
  const row = await prisma.oauthClientRequest.findUnique({ where: { id: requestId } });

  if (!row || row.userId !== userId) {
    return null;
  }

  return { id: row.id, server: row.server };
}

export async function provisionOauthClient(
  userId: string,
  requestId: string,
  clientId: string,
  clientSecret: string,
): Promise<void> {
  const request = await getOauthClientRequest(userId, requestId);

  if (!request) {
    throw new Error('The OAuth client request does not exist or is already fulfilled');
  }

  const normalizedClientId = clientId.trim();
  const normalizedClientSecret = clientSecret.trim();

  if (!normalizedClientId) {
    throw new Error('Client ID is required');
  }

  // Consume atomically: the request row dies with the client landing.
  const consumed = await prisma.$transaction(async tx => {
    const row = await tx.oauthClientRequest.findUnique({ where: { id: request.id } });

    if (!row || row.userId !== userId) {
      throw new Error('The OAuth client request does not exist or is already fulfilled');
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
    await journal(CONNECTION_FAILED, { server: row.server, account: row.accountKey, name: row.displayName, error });

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
  dropUserClient(row.server, row.userId, row.accountKey);

  if (server.identityProbe) {
    // The pre-flow snapshot (`row` was read before the token exchange) tells
    // whether this flow gave birth to the row, and holds the tokens/status to
    // restore when the consent turns out to target a different account.
    const bornHere = !row.identityId && row.status === 'pending';

    let outcome: IdentityOutcome;

    try {
      outcome = await establishIdentity(server.identityProbe, row, bornHere);
    } catch (error) {
      // Identity is a best-effort annotation at this point — a crash here
      // must not turn a completed authorization into a raw 500 with no
      // journaled event. The lazy backfill retries later.
      console.error(`[connections] identity establishment failed for "${row.server}" (${row.accountKey}):`, error);
      outcome = { kind: 'unknown', reason: getErrorMessage(error) };
    }

    if (outcome.kind === 'wrong-account') {
      await journal(CONNECTION_FAILED, {
        server: row.server,
        account: row.accountKey,
        name: row.displayName,
        error: outcome.error,
      });

      return { ok: false, error: outcome.error };
    }

    if (outcome.kind === 'twin') {
      // The consent landed on an already-connected provider account; its row
      // took the fresh tokens, so its live client is stale too.
      dropUserClient(row.server, row.userId, outcome.twinAccountKey);
      await journal(CONNECTION_COMPLETED, {
        server: row.server,
        account: outcome.twinAccountKey,
        name: outcome.twinName,
        identity: outcome.label,
        alreadyConnected: true,
        requestedAccount: row.accountKey,
      });

      return { ok: true, server: row.server };
    }

    if (outcome.kind === 'unknown') {
      console.error(`[connections] identity probe failed for "${row.server}" (${row.accountKey}): ${outcome.reason}`);
    }

    await journal(CONNECTION_COMPLETED, {
      server: row.server,
      account: row.accountKey,
      name: row.displayName,
      identity: outcome.kind === 'ok' ? outcome.label : null,
    });

    return { ok: true, server: row.server };
  }

  await journal(CONNECTION_COMPLETED, { server: row.server, account: row.accountKey, name: row.displayName });

  return { ok: true, server: row.server };
}

type IdentityOutcome =
  | { kind: 'ok'; label: string | null }
  // The probe could not answer; the connection stays identity-less and the
  // lazy backfill retries on later connects.
  | { kind: 'unknown'; reason: string }
  | { kind: 'twin'; twinAccountKey: string; twinName: string; label: string | null }
  | { kind: 'wrong-account'; error: string };

// Puts the flow's row back exactly as it was before the exchange: the old
// tokens are still honored by providers (issuing new ones does not revoke
// them), so a healthy account survives a mistaken consent untouched.
async function restorePreFlowState(preFlow: ConnectionModel): Promise<void> {
  await prisma.connection.update({
    where: { id: preFlow.id },
    data: {
      tokens: (preFlow.tokens ?? Prisma.DbNull) as Prisma.InputJsonValue,
      metadata: (preFlow.metadata ?? Prisma.DbNull) as Prisma.InputJsonValue,
      status: preFlow.status,
    },
  });
}

// Establishes the provider identity of a just-authorized connection and
// resolves it against the sibling rows of (user, server). preFlow is the row
// as it was when the callback started — before the token exchange — kept for
// restoring the row when the consent targeted a different provider account.
async function establishIdentity(
  probe: IdentityProbeConfig,
  preFlow: ConnectionModel,
  bornHere: boolean,
): Promise<IdentityOutcome> {
  const fresh = await prisma.connection.findUnique({ where: { id: preFlow.id } });
  const accessToken = getAccessToken(fresh?.tokens);

  if (!fresh || !accessToken) {
    return { kind: 'unknown', reason: 'no stored access token' };
  }

  let identity: ProbedIdentity;

  try {
    identity = await probeIdentity(probe, accessToken);
  } catch (error) {
    return { kind: 'unknown', reason: getErrorMessage(error) };
  }

  const twin = await prisma.connection.findFirst({
    where: { userId: fresh.userId, server: fresh.server, identityId: identity.id, NOT: { id: fresh.id } },
  });

  if (!twin) {
    if (fresh.identityId && fresh.identityId !== identity.id) {
      // An established account was authorized with a different provider
      // session. The address must keep its meaning: the foreign tokens are
      // discarded and the row goes back to its pre-flow state — a healthy
      // account stays healthy.
      await restorePreFlowState(preFlow);

      const bound = identityLabel(fresh.identity) ?? fresh.identityId;

      return {
        kind: 'wrong-account',
        error: `Authorized as "${identity.label ?? identity.id}", but account "${fresh.accountKey}" is bound to "${bound}" — the account is left as it was. Re-authorize it with the right provider session, or connect the new one as a separate account.`,
      };
    }

    await prisma.connection.update({
      where: { id: fresh.id },
      data: { identityId: identity.id, identity: identityData(identity) },
    });

    return { kind: 'ok', label: identity.label };
  }

  // Twin: this provider account already lives in a sibling row — the consent
  // re-authorizes that row. A row born by this very flow dies; an established
  // row goes back to its pre-flow state.
  await prisma.connection.update({
    where: { id: twin.id },
    data: {
      tokens: (fresh.tokens ?? Prisma.DbNull) as Prisma.InputJsonValue,
      metadata: (fresh.metadata ?? Prisma.DbNull) as Prisma.InputJsonValue,
      status: 'connected',
      identity: identityData(identity),
    },
  });

  if (bornHere) {
    await prisma.connection.delete({ where: { id: fresh.id } });
  } else {
    await restorePreFlowState(preFlow);
  }

  return { kind: 'twin', twinAccountKey: twin.accountKey, twinName: twin.displayName, label: identity.label };
}

// Marks a previously connected connection as needing reauthorization —
// addressed to one connection row, not the whole server. Only the
// connected → reauthorization_required transition emits an event, so a
// repeatedly failing connect cannot flood the log.
export async function markReauthorizationRequired(connectionId: string, error: string): Promise<void> {
  const row = await prisma.connection.findUnique({ where: { id: connectionId } });

  if (!row || row.status !== 'connected') {
    return;
  }

  await prisma.connection.update({ where: { id: row.id }, data: { status: 'reauthorization_required' } });
  await appendEvent({
    type: CONNECTION_REAUTHORIZATION_REQUIRED,
    actor: 'system',
    userId: row.userId,
    threadId: null,
    targetThreadId: row.threadId,
    payload: {
      server: row.server,
      account: row.accountKey,
      name: row.displayName,
      identity: identityLabel(row.identity),
      error,
    },
  }).catch(appendError => {
    console.error(`[connections] failed to journal reauthorization for "${row.server}":`, appendError);
  });
}
