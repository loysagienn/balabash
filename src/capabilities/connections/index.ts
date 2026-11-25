// Per-workspace authorization for external MCP servers with auth: "user".
//
// A capability config registers the server once for everyone; each workspace then
// connects their own account through a one-time link issued by the auth
// agent. The pieces:
// - requestAuthorization issues the link (auth-agent tool);
// - GET /connect/<server>?nonce=… runs OAuth discovery (plus DCR when the
//   provider supports it) and redirects to the consent page;
// - GET /oauth/callback exchanges the code for tokens.
// A service authorized by key has no OAuth in it: the link is the console's
// form where the user enters their key (the part "Accounts authorized by a
// key" below), and the key is kept and served as the account's access token.
// Tokens live in the connections table; the log only sees sanitized
// connection.* lifecycle events addressed to the initiating thread (§4.2) —
// append redirects them to the main thread when that thread is gone (§4.3).

import crypto from 'node:crypto';
import { auth, discoverOAuthServerInfo } from '@modelcontextprotocol/sdk/client/auth.js';
import { Prisma } from '../../../prisma-generated/client.ts';
import type { ConnectionModel } from '../../../prisma-generated/models.ts';
import { prisma } from '../../db/client.ts';
import type { JsonObject, TaskAuthor } from '../../core/contract.ts';
import type { ConnectionView } from '../../api/contract.ts';
import type { ConnectionRecord } from '../../core/event-types.ts';
import { appendEvent, appendEventIn, logTransaction } from '../../core/append.ts';
import { notifyAppended } from '../../core/live.ts';
import { openSecretRequest, secretRequestUrl } from '../secret-requests.ts';
import {
  CONNECTION_COMPLETED,
  CONNECTION_DISCONNECTED,
  CONNECTION_FAILED,
  CONNECTION_PENDING,
  CONNECTION_REAUTHORIZATION_REQUIRED,
  CONNECTION_RENAMED,
  OAUTH_CLIENT_PROVISIONED,
} from '../../core/envelope.ts';
import { config } from '../../config/index.ts';
import { accountCatalogChanged, getAccountService, type AccountService } from './services.ts';
import { AuthorizationLostError, connectionAccessToken, createInteractiveAuthProvider } from './oauth-provider.ts';
import { ProbeRefusedError, getAccessToken, identityData, identityLabel, probeIdentity } from './identity.ts';
import type { ProbedIdentity } from './identity.ts';
import type { IdentityProbeConfig } from '../server-config.ts';
import { DEFAULT_ACCOUNT_KEY, deriveAccountKey } from './account-key.ts';

// A refusal of a connection command, for the two callers alike: the auth
// tools answer the model with the message, the console's endpoints map the
// code to a status (src/api/api.ts) — 400 a malformed ask, 404 no such
// service or account, 409 a rule of the registry (a name in use, a service
// that holds one account, a manual OAuth client not provisioned yet) or a
// row that is not the one the caller meant (replaced: the address belongs
// to another row by now).
export type ConnectionErrorCode = 'bad_request' | 'not_found' | 'conflict' | 'replaced';

export class ConnectionError extends Error {
  readonly code: ConnectionErrorCode;

  constructor(code: ConnectionErrorCode, message: string) {
    super(message);
    this.name = 'ConnectionError';
    this.code = code;
  }
}

// The link survives Telegram preview fetches and stray clicks: it stays valid
// until this TTL or a completed authorization, whichever comes first. Each
// click just restarts the flow with a fresh OAuth state.
const CONNECT_LINK_TTL_MS = 15 * 60 * 1000;

// The link of an account authorized by a key leads to a form behind the
// session, so it is an address, not a credential — and the user may well
// leave to create the key at the provider before filling the form.
const KEY_LINK_TTL_MS = 24 * 60 * 60 * 1000;

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function randomToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}

function getServer(serverName: string): AccountService {
  const server = getAccountService(serverName);

  if (!server) {
    throw new ConnectionError('not_found', `Unknown integration "${serverName}"`);
  }

  return server;
}

// The registry of one (workspace, server) changes one command at a time: a
// command runs its checks and its write in one transaction under an
// advisory lock keyed by the pair, so what it checked (the row it means, a
// name in use, how many accounts the service holds, whether an account at
// this address exists) still holds when it writes. The lock is the pair's,
// not the log's: the lifecycle event is journaled after the commit, as
// before. A refusal thrown inside rolls the transaction back.
async function underServerLock<T>(workspaceId: string, serverName: string, work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(async tx => {
    // Executed, not queried: the function returns void, which the client
    // cannot read as a column.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${workspaceId}), hashtext(${serverName}))`;

    return work(tx);
  });
}

export async function getOauthClient(serverName: string): Promise<Record<string, unknown> | null> {
  const row = await prisma.oauthClient.findUnique({ where: { server: serverName } });

  return (row?.clientInformation as Record<string, unknown> | null) ?? null;
}

// Which services hold an OAuth client, by name — the client itself is not
// read.
export async function listProvisionedOauthClients(): Promise<Set<string>> {
  return new Set((await prisma.oauthClient.findMany({ select: { server: true } })).map(row => row.server));
}

export async function hasOauthClient(serverName: string): Promise<boolean> {
  return (await prisma.oauthClient.count({ where: { server: serverName } })) > 0;
}

async function requireManualOauthClient(server: AccountService): Promise<void> {
  if (server.clientRegistration !== 'manual') {
    return;
  }

  if (!(await getOauthClient(server.name))) {
    throw new ConnectionError(
      'conflict',
      `Integration "${server.name}" needs installation OAuth client credentials before user authorization`,
    );
  }
}

// Ordered by birth: the oldest account of a server is deterministically its
// canonical one in the client registry — never Postgres plan roulette.
export async function listWorkspaceConnections(workspaceId: string) {
  return prisma.connection.findMany({ where: { workspaceId }, orderBy: { createdAt: 'asc' } });
}

// The accounts of the workspace — all, or of one service — as anyone may
// see them: who they are and how they stand, never their tokens.
export async function listAccounts(workspaceId: string, server?: string) {
  return prisma.connection.findMany({
    where: { workspaceId, server },
    orderBy: { createdAt: 'asc' },
    select: { id: true, server: true, accountKey: true, displayName: true, identity: true, status: true },
  });
}

// One row of the user by its id — the address the console's endpoints
// use; a row of another workspace and a missing one are the same null (the
// api's 404, no existence oracle).
export async function getWorkspaceConnection(workspaceId: string, id: string): Promise<ConnectionModel | null> {
  const row = await prisma.connection.findUnique({ where: { id } });

  return row && row.workspaceId === workspaceId ? row : null;
}

// The row as the console sees it — in the snapshot (ConnectionView) and in
// connection.pending (ConnectionRecord: the same fields under the names of
// the other connection.* events, dates as ISO strings). Never the tokens.
export function connectionView(row: ConnectionModel): ConnectionView {
  return {
    id: row.id,
    server: row.server,
    accountKey: row.accountKey,
    displayName: row.displayName,
    status: row.status,
    identity: identityLabel(row.identity),
    scope: isObject(row.metadata) && typeof row.metadata.scope === 'string' ? row.metadata.scope : null,
    threadId: row.threadId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function connectionRecord(row: ConnectionModel): ConnectionRecord {
  const view = connectionView(row);

  return {
    connectionId: view.id,
    server: view.server,
    account: view.accountKey,
    name: view.displayName,
    status: view.status,
    identity: view.identity,
    scope: view.scope,
    threadId: view.threadId,
    createdAt: view.createdAt.toISOString(),
    updatedAt: view.updatedAt.toISOString(),
  };
}

// The lifecycle events of a connection: actor system, addressed to the
// thread that drives the account (the auth agent's; append redirects to
// the main thread when it is gone). A failure to journal is logged — the
// row has already changed.
async function journalConnectionEvent(type: string, row: { workspaceId: string; threadId: string | null; server: string }, payload: JsonObject): Promise<void> {
  await appendEvent({
    type,
    actor: 'system',
    workspaceId: row.workspaceId,
    threadId: null,
    targetThreadId: row.threadId,
    payload,
  }).catch(error => {
    console.error(`[connections] failed to journal ${type} for "${row.server}":`, error);
  });
}

// The row a command means: the one at the address — and, when the caller
// named the row it saw (the console's endpoints pass the id of the row the
// screen showed: expectId), that very row. An address that meanwhile
// belongs to another row (the account was disconnected and connected
// again under the same address) is refused; the newcomer is not touched.
async function requireConnection(db: Prisma.TransactionClient, workspaceId: string, serverName: string, accountKey: string, expectId?: string): Promise<ConnectionModel> {
  const row = await db.connection.findUnique({
    where: { workspaceId_server_accountKey: { workspaceId, server: serverName, accountKey } },
  });

  if (!row) {
    const rows = await db.connection.findMany({ where: { workspaceId, server: serverName } });
    const known = rows.map(candidate => `${candidate.accountKey} — "${candidate.displayName}"`).join('; ') || '(none)';

    throw new ConnectionError('not_found', `No account "${accountKey}" of "${serverName}". Accounts: ${known}`);
  }

  if (expectId !== undefined && row.id !== expectId) {
    throw new ConnectionError('replaced', `Account "${accountKey}" of "${serverName}" was disconnected and connected again meanwhile — it is not the account you saw. Reload and retry.`);
  }

  return row;
}

// Renames the display name of one account. The slug (the address) and the
// provider identity never change.
export async function renameConnection(
  workspaceId: string,
  serverName: string,
  accountKey: string,
  name: string,
  // The calling thread (the auth agent's) — the addressee of the event.
  threadId?: string,
  // The row the caller means (the console's endpoint): see requireConnection.
  expectId?: string,
): Promise<{ accountKey: string; previousName: string; name: string; connection: ConnectionModel }> {
  const trimmed = name.trim();
  const { row, renamed } = await underServerLock(workspaceId, serverName, async tx => {
    const row = await requireConnection(tx, workspaceId, serverName, accountKey, expectId);

    if (!trimmed) {
      throw new ConnectionError('bad_request', 'The new name must not be empty');
    }

    // Case-insensitive, matching the name check at connect time.
    const clash = await tx.connection.findFirst({
      where: { workspaceId, server: serverName, displayName: { equals: trimmed, mode: 'insensitive' }, NOT: { id: row.id } },
    });

    if (clash) {
      throw new ConnectionError('conflict', `Name "${trimmed}" is already used by account "${clash.accountKey}" of "${serverName}"`);
    }

    return { row, renamed: await tx.connection.update({ where: { id: row.id }, data: { displayName: trimmed } }) };
  });

  await journalConnectionEvent(CONNECTION_RENAMED, { ...row, threadId: threadId ?? row.threadId }, {
    connectionId: row.id,
    server: row.server,
    account: row.accountKey,
    name: trimmed,
    previousName: row.displayName,
  });

  return { accountKey: row.accountKey, previousName: row.displayName, name: trimmed, connection: renamed };
}

// Disconnects one account: the row dies and the
// slug becomes free. Tokens go with the row; access at the provider side is
// revoked by the user in the provider's own UI.
export async function disconnectConnection(
  workspaceId: string,
  serverName: string,
  accountKey: string,
  threadId?: string,
  // The row the caller means (the console's endpoint): see requireConnection.
  expectId?: string,
): Promise<{ accountKey: string; name: string }> {
  const row = await underServerLock(workspaceId, serverName, async tx => {
    const row = await requireConnection(tx, workspaceId, serverName, accountKey, expectId);

    await tx.connection.delete({ where: { id: row.id } });

    return row;
  });

  await accountCatalogChanged(row.server, workspaceId, 'disconnected');
  await journalConnectionEvent(CONNECTION_DISCONNECTED, { ...row, threadId: threadId ?? row.threadId }, {
    connectionId: row.id,
    server: row.server,
    account: row.accountKey,
    name: row.displayName,
    reason: 'disconnected',
  });

  return { accountKey: row.accountKey, name: row.displayName };
}

// The one-time link as issued: the address, the row it belongs to (as the
// console sees it — the link is never in the log) and the moment the link
// stops working (each click until then restarts the flow with a fresh
// OAuth state).
export type ConnectLink = { url: string; connection: ConnectionView; expiresAt: Date };

// What a link is asked for — the two callers of the one issue.
type LinkTarget =
  // The console's "Reconnect": this very row, as the screen showed it —
  // re-authorized; gone meanwhile, not found (never born again).
  | { kind: 'row'; id: string }
  // The console's "Connect": a new account — nameless, the service's first
  // under the default address; named, one named so under an address
  // derived from the name. Never a re-authorization: an address or a name
  // that is taken by the time of the write is a refusal.
  | { kind: 'new'; name: string | null };

type LinkResolution = { existing: ConnectionModel } | { create: { accountKey: string; displayName: string } };

// The row the target names among the rows of (workspace, server) as they are
// under the lock, or the row to create.
function resolveLinkTarget(server: AccountService, target: LinkTarget, rows: ConnectionModel[]): LinkResolution {
  switch (target.kind) {
    case 'row': {
      const existing = rows.find(row => row.id === target.id);

      if (!existing) {
        throw new ConnectionError('not_found', 'No such connection');
      }

      return { existing };
    }
    case 'new': {
      const trimmed = target.name?.trim() || null;

      if (!trimmed) {
        if (rows.length) {
          throw new ConnectionError('conflict', `"${server.name}" already has an account — name the new one, or reconnect the existing account instead`);
        }

        return { create: { accountKey: DEFAULT_ACCOUNT_KEY, displayName: server.name } };
      }

      const clash = rows.find(row => row.displayName.trim().toLowerCase() === trimmed.toLowerCase());

      if (clash) {
        throw new ConnectionError('conflict', `Name "${trimmed}" is already used by account "${clash.accountKey}" of "${server.name}" — reconnect that account instead`);
      }

      return { create: { accountKey: deriveAccountKey(trimmed, new Set([...rows.map(row => row.accountKey), DEFAULT_ACCOUNT_KEY])), displayName: trimmed } };
    }
  }
}

// The rows that keep the multiplicity gate shut: a row without a known
// identity that holds tokens (a row with no stored tokens holds no provider
// account — an abandoned link, a cleared re-auth — there is nothing for a
// twin to hide behind; the callback's twin check covers it if it ever
// completes).
function identityUnknown(rows: ConnectionModel[]): ConnectionModel[] {
  return rows.filter(row => !row.identityId && getAccessToken(row.tokens));
}

// The multiplicity gate of a new account, judged under the lock without a
// network call: a service without an identity probe holds one account; a
// service with one adds an account only while every existing account's
// identity is known (else the twin guard is blind). The backfill that
// asks the provider ran before the lock (issueLink); its refusals are
// told by row, a row that appeared since is told to retry.
function assertCanCreate(server: AccountService, rows: ConnectionModel[], backfillRefusals: Map<string, string>): void {
  if (!rows.length) {
    return;
  }

  if (!server.identityProbe) {
    throw new ConnectionError(
      'conflict',
      `Integration "${server.name}" declares no identity probe, so it holds at most one connected account`,
    );
  }

  const [blind] = identityUnknown(rows);

  if (blind) {
    const reason = backfillRefusals.get(blind.id) ?? 'the account appeared while this link was being issued';

    throw new ConnectionError(
      'conflict',
      `Cannot add another "${server.name}" account yet: the identity of account "${blind.accountKey}" is unknown (${reason}). Retry once the reason is gone, or re-authorize that account first.`,
    );
  }
}

// Issues a one-time authorization link for the target: the row is updated
// (re-authorization: a fresh nonce, the issuing thread, the status pending
// unless the account is connected — then its status only changes when the
// new flow completes) or created pending, under the (workspace, server) lock,
// so the rules hold at the write. threadId is the issuing thread — the auth
// agent's, or the main thread when the operator asks from the console: the
// flow's connection.* events are addressed to it.
async function issueLink(workspaceId: string, threadId: string, server: AccountService, target: LinkTarget): Promise<ConnectLink> {
  await requireManualOauthClient(server);

  // The backfill asks the provider — outside the lock and the transaction;
  // the gate is judged again inside, on the rows as they are then.
  const backfillRefusals = new Map<string, string>();
  const seen = await prisma.connection.findMany({ where: { workspaceId, server: server.name } });

  if (target.kind === 'new' && server.identityProbe) {
    for (const row of identityUnknown(seen)) {
      const backfill = await backfillConnectionIdentity({ url: server.url, identityProbe: server.identityProbe }, row.id);

      if (!backfill.ok) {
        backfillRefusals.set(row.id, backfill.reason);
      }
    }
  }

  // A key account's row carries the nonce too, though no link shows it: a
  // nonce and a moment not yet passed are what an open link is (keyLinkOpen).
  const connectNonce = randomToken();
  const expiresAt = new Date(Date.now() + (server.key ? KEY_LINK_TTL_MS : CONNECT_LINK_TTL_MS));
  const pending = { expiresAt: expiresAt.toISOString() };
  const row = await underServerLock(workspaceId, server.name, async tx => {
    const rows = await tx.connection.findMany({ where: { workspaceId, server: server.name } });
    const resolved = resolveLinkTarget(server, target, rows);

    if ('existing' in resolved) {
      return tx.connection.update({
        where: { id: resolved.existing.id },
        data: {
          threadId,
          connectNonce,
          pendingState: null,
          pending,
          // A connected user may re-authorize; their status only changes when
          // the new flow completes.
          ...(resolved.existing.status === 'connected' ? {} : { status: 'pending' }),
        },
      });
    }

    assertCanCreate(server, rows, backfillRefusals);

    return tx.connection.create({
      data: {
        workspaceId,
        threadId,
        server: server.name,
        accountKey: resolved.create.accountKey,
        displayName: resolved.create.displayName,
        status: 'pending',
        connectNonce,
        pending,
      },
    });
  });

  // The link exists: the row is (or stays) in the registry — the event
  // carries it whole, the nonce and the tokens stay out of the log.
  await journalConnectionEvent(CONNECTION_PENDING, row, connectionRecord(row));

  // By OAuth the link starts the flow at the provider; by key it is the
  // console's form of this very row (getAccountKeyRequest).
  const url = server.key ? secretRequestUrl(row.id, workspaceId) : `https://${config.consoleDomain}/connect/${server.name}?nonce=${connectNonce}`;

  return { url, connection: connectionView(row), expiresAt };
}

// The console's "Reconnect" of one row: a link for that very row (its
// re-authorization); a row of another workspace and a missing one are one
// not-found — a row gone by the write is not born again.
export async function reconnectConnection(workspaceId: string, threadId: string, id: string): Promise<ConnectLink> {
  const row = await getWorkspaceConnection(workspaceId, id);

  if (!row) {
    throw new ConnectionError('not_found', 'No such connection');
  }

  return issueLink(workspaceId, threadId, getServer(row.server), { kind: 'row', id: row.id });
}

// The console's "Connect" on a service of the catalog: a link for a new
// account. With a name — a new account named so (the address derived from
// the name; a name in use is refused — that
// account is re-authorized from its own row); without — the service's
// first account under the default address, and a refusal once the service
// has one (another account needs a name, an existing one its own
// "Reconnect"). The link-issuing rules (one account without an identity
// probe, a manual OAuth client not provisioned) are issueLink's.
export async function startConnection(workspaceId: string, threadId: string, serverName: string, name: string | null): Promise<ConnectLink> {
  return issueLink(workspaceId, threadId, getServer(serverName), { kind: 'new', name });
}

// Records a pending request for a manual installation OAuth client
// (../secret-requests.ts: the row and its oauth_client.requested event in
// one transaction) and returns the operator's link into the web interface
// (session-gated page; the id is an address, not a credential — ownership
// is checked at the API edge). No TTL: the request lives until fulfilled or
// replaced. Submitted values never enter the event log.
export async function requestOauthClientCredentials(
  workspaceId: string,
  threadId: string,
  serverName: string,
  task?: TaskAuthor,
): Promise<string> {
  const row = await openOauthClientRequest(workspaceId, threadId, serverName, task);

  return secretRequestUrl(row.id, workspaceId);
}

// The request itself, by id — the console's route answers the id and sends
// the tab to the form. A provisioned client is replaced through the same
// request: provisionOauthClient upserts the row.
export async function openOauthClientRequest(
  workspaceId: string,
  threadId: string,
  serverName: string,
  task?: TaskAuthor,
): Promise<{ id: string }> {
  const server = getServer(serverName);

  if (server.clientRegistration !== 'manual') {
    throw new ConnectionError('not_found', `Integration "${server.name}" uses Dynamic Client Registration`);
  }

  return openSecretRequest('oauth-client', { workspaceId, threadId, task, server: server.name });
}

export type OauthClientRequestView = {
  id: string;
  server: string;
};

// Metadata only, session-derived workspaceId; foreign or missing → null (the
// caller's 404). The server config is deliberately not consulted here.
export async function getOauthClientRequest(workspaceId: string, requestId: string): Promise<OauthClientRequestView | null> {
  const row = await prisma.oauthClientRequest.findUnique({ where: { id: requestId } });

  if (!row || row.workspaceId !== workspaceId) {
    return null;
  }

  return { id: row.id, server: row.server };
}

export async function provisionOauthClient(
  workspaceId: string,
  requestId: string,
  clientId: string,
  clientSecret: string,
): Promise<void> {
  const request = await getOauthClientRequest(workspaceId, requestId);

  if (!request) {
    throw new Error('The OAuth client request does not exist or is already fulfilled');
  }

  const normalizedClientId = clientId.trim();
  const normalizedClientSecret = clientSecret.trim();

  if (!normalizedClientId) {
    throw new Error('Client ID is required');
  }

  // Consume atomically: the request row dies with the client landing, and
  // the sanitized fact for the log — field names only (§2 ставка 4),
  // addressed to the issuing thread (appendEventIn redirects to the main
  // thread when it is gone) — commits with them or not at all: the row is
  // a registry the console's snapshot shows (src/core/registry-events.ts).
  // A refused journal refuses the POST; the row stays for another try. The
  // live tail is told after the commit.
  const seq = await logTransaction(async tx => {
    const row = await tx.oauthClientRequest.findUnique({ where: { id: request.id } });

    if (!row || row.workspaceId !== workspaceId) {
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

    const appended = await appendEventIn(tx, {
      type: OAUTH_CLIENT_PROVISIONED,
      actor: 'system',
      workspaceId: row.workspaceId,
      threadId: null,
      targetThreadId: row.threadId,
      payload: {
        requestId: row.id,
        server: row.server,
        fields: normalizedClientSecret ? ['client_id', 'client_secret'] : ['client_id'],
      },
    });

    return appended.written ? appended.event.seq : null;
  });

  if (seq !== null) {
    notifyAppended(seq);
  }
}

// Handles a click on the one-time link: runs OAuth discovery (and dynamic
// client registration when needed) and returns the provider's consent URL to
// redirect the browser to.
export async function handleConnectClick(serverName: string, nonce: string): Promise<string> {
  const server = getServer(serverName);

  if (server.key) {
    throw new Error(`"${server.name}" is connected with a key, not a sign-in — open the link from the chat or the Connections screen`);
  }

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

  // The authorization server of this flow, discovered the way the SDK's
  // auth() is about to discover it (fresh, not the process-wide cache — a
  // resource server that moved its authorization is seen moved here too):
  // the stored client registration is judged against it, see
  // registrationFromAuthorizationServer.
  const { authorizationServerUrl } = await discoverOAuthServerInfo(server.url);
  const capture: { url: URL | null } = { url: null };
  const result = await auth(createInteractiveAuthProvider(row, capture, authorizationServerUrl), {
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
    if (type === CONNECTION_COMPLETED) await accountCatalogChanged(row.server, row.workspaceId, 'connected');
    await appendEvent({
      type,
      actor: 'system',
      workspaceId: row.workspaceId,
      threadId: null,
      targetThreadId: row.threadId,
      payload,
    }).catch(error => {
      console.error(`[connections] failed to journal ${type} for "${row.server}":`, error);
    });
  };

  // The row as it is once the flow is over, whole (ConnectionRecord): the
  // console folds the event into its copy of the registry, and scope,
  // status, identity and dates come from the row, not from the flow's
  // guesses. The id may name another row than the flow's own when the
  // consent landed on an already connected account.
  const completed = async (id: string, fallback: { account: string; name: string; identity: string | null }, outcome: JsonObject = {}): Promise<JsonObject> => {
    const final = await prisma.connection.findUnique({ where: { id } });

    return { connectionId: id, server: row.server, ...fallback, ...(final ? connectionRecord(final) : {}), ...outcome };
  };

  const fail = async (error: string): Promise<OauthCallbackResult> => {
    await prisma.connection.update({ where: { id: row.id }, data: { pendingState: null } });
    await journal(CONNECTION_FAILED, { connectionId: row.id, server: row.server, account: row.accountKey, name: row.displayName, error });

    return { ok: false, error };
  };

  if (providerError) {
    const description = typeof query.error_description === 'string' ? `: ${query.error_description}` : '';

    return fail(`${providerError}${description}`);
  }

  if (!code) {
    return fail('Authorization response contains no code');
  }

  let server: AccountService;

  try {
    server = getServer(row.server);
  } catch (error) {
    return fail(getErrorMessage(error));
  }

  try {
    // The same judgement of the client registration as at the consent step,
    // against the same (freshly discovered) authorization server.
    const { authorizationServerUrl } = await discoverOAuthServerInfo(server.url);
    const capture: { url: URL | null } = { url: null };
    const result = await auth(createInteractiveAuthProvider(row, capture, authorizationServerUrl), {
      serverUrl: server.url,
      authorizationCode: code,
    });

    if (result !== 'AUTHORIZED') {
      return fail(`Authorization flow returned unexpected result "${result}"`);
    }
  } catch (error) {
    return fail(getErrorMessage(error));
  }

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
      // journaled event. The backfill asks again later.
      console.error(`[connections] identity establishment failed for "${row.server}" (${row.accountKey}):`, error);
      outcome = { kind: 'unknown', reason: getErrorMessage(error) };
    }

    if (outcome.kind === 'wrong-account') {
      await journal(CONNECTION_FAILED, {
        connectionId: row.id,
        server: row.server,
        account: row.accountKey,
        name: row.displayName,
        error: outcome.error,
      });

      return { ok: false, error: outcome.error };
    }

    if (outcome.kind === 'twin') {
      if (bornHere) {
        // The newborn row died in establishIdentity: the registry lost it.
        await journal(CONNECTION_DISCONNECTED, {
          connectionId: row.id,
          server: row.server,
          account: row.accountKey,
          name: row.displayName,
          reason: 'duplicate',
        });
      }

      await journal(
        CONNECTION_COMPLETED,
        await completed(outcome.twinId, { account: outcome.twinAccountKey, name: outcome.twinName, identity: outcome.label }, { alreadyConnected: true, requestedAccount: row.accountKey }),
      );

      return { ok: true, server: row.server };
    }

    if (outcome.kind === 'unknown') {
      console.error(`[connections] identity probe failed for "${row.server}" (${row.accountKey}): ${outcome.reason}`);
    }

    await journal(CONNECTION_COMPLETED, await completed(row.id, { account: row.accountKey, name: row.displayName, identity: outcome.kind === 'ok' ? outcome.label : null }));

    return { ok: true, server: row.server };
  }

  await journal(CONNECTION_COMPLETED, await completed(row.id, { account: row.accountKey, name: row.displayName, identity: null }));

  return { ok: true, server: row.server };
}

type IdentityOutcome =
  | { kind: 'ok'; label: string | null }
  // The probe could not answer; the connection stays identity-less and the
  // backfill asks again before another account is added.
  | { kind: 'unknown'; reason: string }
  | { kind: 'twin'; twinId: string; twinAccountKey: string; twinName: string; label: string | null }
  | { kind: 'wrong-account'; error: string };

// Puts the flow's row back exactly as it was before the exchange: the old
// tokens are still honored by providers (issuing new ones does not revoke
// them), so a healthy account survives a mistaken consent untouched. The
// link too: the exchange consumed the nonce (saveTokens), but the flow did
// not complete — the link lives until its TTL, as the chat and the console
// still show it, and the next click restarts the flow with a fresh OAuth
// state; a nonce issued meanwhile (a newer link) stays.
async function restorePreFlowState(preFlow: ConnectionModel): Promise<void> {
  await prisma.connection.update({
    where: { id: preFlow.id },
    data: {
      tokens: (preFlow.tokens ?? Prisma.DbNull) as Prisma.InputJsonValue,
      metadata: (preFlow.metadata ?? Prisma.DbNull) as Prisma.InputJsonValue,
      status: preFlow.status,
    },
  });
  await prisma.connection.updateMany({
    where: { id: preFlow.id, connectNonce: null },
    data: {
      connectNonce: preFlow.connectNonce,
      pending: (preFlow.pending ?? Prisma.DbNull) as Prisma.InputJsonValue,
    },
  });
}

// Establishes the provider identity of a just-authorized connection and
// resolves it against the sibling rows of (workspace, server). preFlow is the row
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
    where: { workspaceId: fresh.workspaceId, server: fresh.server, identityId: identity.id, NOT: { id: fresh.id } },
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

  return { kind: 'twin', twinId: twin.id, twinAccountKey: twin.accountKey, twinName: twin.displayName, label: identity.label };
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
  await accountCatalogChanged(row.server, row.workspaceId, 'reauthorization_required');
  await appendEvent({
    type: CONNECTION_REAUTHORIZATION_REQUIRED,
    actor: 'system',
    workspaceId: row.workspaceId,
    threadId: null,
    targetThreadId: row.threadId,
    payload: {
      connectionId: row.id,
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

// The access token of a connected account for a call made straight to the
// provider (connectionAccessToken), with the one thing every such call owes
// the account: an authorization that turns out to be gone — the provider no
// longer honors the refresh token — is recorded on the row, and the thread
// that connected the account gets the event. A client of the installation
// the provider does not accept and an exchange that got no answer say
// nothing about the account: its row stays as it is. The failure is thrown
// on as it came; what it means to the caller is the caller's to say.
export async function accountAccessToken(
  connection: { id: string; server: string },
  serverUrl: string,
  rejected?: string,
): Promise<string> {
  try {
    return getAccountService(connection.server)?.key
      ? await accountKey(connection, rejected)
      : await connectionAccessToken(connection, serverUrl, rejected);
  } catch (error) {
    if (error instanceof AuthorizationLostError) {
      await markReauthorizationRequired(connection.id, error.message);
    }

    throw error;
  }
}

// The key of a connected account of a service authorized by key. Nothing
// renews a key: one the provider has just refused (`rejected`) means the
// authorization is gone — unless the user has entered a newer key
// meanwhile, and then that one is the answer.
async function accountKey(connection: { id: string; server: string }, rejected?: string): Promise<string> {
  const row = await prisma.connection.findUnique({ where: { id: connection.id }, select: { status: true, tokens: true } });
  const key = row?.status === 'connected' ? getAccessToken(row.tokens) : null;

  if (!key) {
    throw new AuthorizationLostError('the account holds no key');
  }

  if (rejected !== undefined && key === rejected) {
    throw new AuthorizationLostError(`${connection.server} no longer accepts the key of the account`);
  }

  return key;
}

// ---------------------------------------------------------------------------
// Accounts authorized by a key. The link of such an account (issueLink) is
// the console's secrets form addressed by the id of the account's row: the
// row with an open link is the request, and there is no other record of it.
// The key travels the way installation secrets do — from the form straight
// to storage, never through a chat, the model or the log.

function keyLinkOpen(row: ConnectionModel): boolean {
  const pending = isObject(row.pending) ? row.pending : {};

  return row.connectNonce !== null && typeof pending.expiresAt === 'string' && Date.parse(pending.expiresAt) >= Date.now();
}

export type AccountKeyRequestView = { id: string; server: string; label: string; instructions: string | null };

// What the form shows, session-derived workspaceId; a row of another
// workspace, a missing one, a row of an OAuth service and a row without an
// open link are the same null (the caller's 404).
export async function getAccountKeyRequest(workspaceId: string, connectionId: string): Promise<AccountKeyRequestView | null> {
  const row = await getWorkspaceConnection(workspaceId, connectionId);
  const key = row ? getAccountService(row.server)?.key : null;

  if (!row || !key || !keyLinkOpen(row)) {
    return null;
  }

  return { id: row.id, server: row.server, label: key.label, instructions: key.instructions };
}

const KEY_REQUEST_GONE = 'The key request does not exist or has expired';

// Takes the key the user entered for the account of the row. A service with
// an identity probe is asked first, with the key itself: a key it refuses,
// and a key nobody could check, are not stored — the form says so and the
// row stays as it was. The answer says whose key it is, and the sibling
// rows are judged as at an OAuth callback: a key of an account that already
// lives in another row goes to that row (a row born by this link dies), and
// a key of a different provider account than the one the row is bound to is
// refused — the address keeps its meaning. A refusal is thrown as an Error
// with words for the form; the outcome is journaled like an OAuth one.
export async function provisionAccountKey(workspaceId: string, connectionId: string, value: string): Promise<void> {
  const seen = await getWorkspaceConnection(workspaceId, connectionId);
  const server = seen ? getAccountService(seen.server) : null;

  if (!seen || !server?.key || !keyLinkOpen(seen)) {
    throw new Error(KEY_REQUEST_GONE);
  }

  const key = value.trim();

  if (!key) {
    throw new Error(`${server.key.label} is required`);
  }

  let identity: ProbedIdentity | null = null;

  if (server.identityProbe) {
    try {
      identity = await probeIdentity(server.identityProbe, key);
    } catch (error) {
      if (error instanceof ProbeRefusedError && (error.status === 401 || error.status === 403)) {
        throw new Error(`${server.name} refused the key (HTTP ${error.status}) — nothing was saved`);
      }

      throw new Error(`The key could not be checked at ${server.name} (${getErrorMessage(error)}) — nothing was saved, try again`);
    }
  }

  const tokens = { access_token: key };
  const outcome = await underServerLock(workspaceId, server.name, async tx => {
    const row = await tx.connection.findUnique({ where: { id: seen.id } });

    if (!row || !keyLinkOpen(row)) {
      throw new Error(KEY_REQUEST_GONE);
    }

    if (identity && row.identityId && row.identityId !== identity.id) {
      const bound = identityLabel(row.identity) ?? row.identityId;

      throw new Error(
        `This key belongs to "${identity.label ?? identity.id}", but account "${row.accountKey}" is bound to "${bound}" — nothing was changed. Enter a key of that account, or connect the other one as a new account.`,
      );
    }

    const twin = identity
      ? await tx.connection.findFirst({ where: { workspaceId, server: row.server, identityId: identity.id, NOT: { id: row.id } } })
      : null;

    if (twin && identity) {
      const bornHere = !row.identityId && row.status === 'pending';
      const final = await tx.connection.update({
        where: { id: twin.id },
        data: { tokens, status: 'connected', identity: identityData(identity) },
      });

      if (bornHere) {
        await tx.connection.delete({ where: { id: row.id } });
      }

      return { row, final, twin: true, bornHere };
    }

    const final = await tx.connection.update({
      where: { id: row.id },
      data: {
        tokens,
        status: 'connected',
        connectNonce: null,
        pendingState: null,
        pending: Prisma.DbNull,
        ...(identity ? { identityId: identity.id, identity: identityData(identity) } : {}),
      },
    });

    return { row, final, twin: false, bornHere: false };
  });
  const { row, final } = outcome;

  await accountCatalogChanged(row.server, workspaceId, 'connected');

  if (outcome.bornHere) {
    await journalConnectionEvent(CONNECTION_DISCONNECTED, row, {
      connectionId: row.id,
      server: row.server,
      account: row.accountKey,
      name: row.displayName,
      reason: 'duplicate',
    });
  }

  await journalConnectionEvent(CONNECTION_COMPLETED, row, {
    ...connectionRecord(final),
    ...(outcome.twin ? { alreadyConnected: true, requestedAccount: row.accountKey } : {}),
  });
}

// Backfill for a row without identity — one connected before the service
// declared its probe, or one whose probe got no answer at the callback: ask
// the provider who the account is and record the answer. The account is
// asked the way a call of it acts: on its current access, renewed when it
// has expired or the provider refuses it — a row that has not been used
// since its token ran out is no reason to send the user to re-authorize. An
// account whose authorization turns out to be gone is marked like on any
// other call of it (accountAccessToken).
// Refuses to write a twin (two rows claiming one provider account) — that
// conflict is surfaced to the caller, never resolved silently here.
async function backfillConnectionIdentity(
  service: { url: string; identityProbe: IdentityProbeConfig },
  connectionId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const row = await prisma.connection.findUnique({ where: { id: connectionId } });

  if (!row) {
    return { ok: false, reason: 'connection no longer exists' };
  }

  if (row.identityId) {
    return { ok: true };
  }

  if (row.status !== 'connected') {
    return { ok: false, reason: 'the account is not connected' };
  }

  let identity: ProbedIdentity;

  try {
    const accessToken = await accountAccessToken(row, service.url);

    identity = await probeIdentity(service.identityProbe, accessToken).catch(async (error: unknown) => {
      if (!(error instanceof ProbeRefusedError) || error.status !== 401) {
        throw error;
      }

      return probeIdentity(service.identityProbe, await accountAccessToken(row, service.url, accessToken));
    });
  } catch (error) {
    return { ok: false, reason: getErrorMessage(error) };
  }

  const twin = await prisma.connection.findFirst({
    where: { workspaceId: row.workspaceId, server: row.server, identityId: identity.id, NOT: { id: row.id } },
  });

  if (twin) {
    return {
      ok: false,
      reason: `provider account "${identity.label ?? identity.id}" is already connected as "${twin.accountKey}"`,
    };
  }

  try {
    await prisma.connection.update({
      where: { id: row.id },
      data: { identityId: identity.id, identity: identityData(identity) },
    });
  } catch (error) {
    // A twin created concurrently lands here as a unique violation — surface
    // it like the check above instead of throwing into the caller.
    return { ok: false, reason: getErrorMessage(error) };
  }

  return { ok: true };
}
