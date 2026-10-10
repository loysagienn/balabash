// The open requests for installation credentials — the one-time links the
// auth agent sends the operator (§10, §2 ставка 4): installation secrets of
// an external MCP server (external_server_secret_requests, external-secrets.ts)
// and a manual installation-level OAuth client (oauth_client_requests,
// connections/index.ts). The console's bell shows an open request until
// the values land, so the rows are a registry the snapshot carries
// (src/api/snapshot.ts) and the log records: a request opened is a
// secrets.requested / oauth_client.requested event journaled in the row's
// transaction (src/core/registry-events.ts), authored by the thread that
// issued the link; the values landing is the provisioned event the
// provisioning writes. The row lives until fulfilled or replaced — a
// request issued again for the same server keeps the row (and the link)
// and carries the new moment. Never values: field names only.

import crypto from 'node:crypto';
import { prisma } from '../db/client.ts';
import type { Tx } from '../core/append.ts';
import { registryMutation } from '../core/registry-events.ts';
import type { Prisma } from '../../prisma-generated/client.ts';
import { OAUTH_CLIENT_REQUESTED, SECRETS_REQUESTED } from '../core/envelope.ts';
import type { SecretRequestRecord } from '../core/event-types.ts';
import type { OpenSecretRequestView } from '../api/contract.ts';
import type { ExternalServerSecretField } from './external-secrets.ts';

export type SecretRequestKind = OpenSecretRequestView['kind'];

// The fields of a manual OAuth client — fixed by the form (src/api/api.ts).
export const OAUTH_CLIENT_FIELDS: readonly string[] = ['client_id', 'client_secret'];

export type OpenSecretRequestInput = {
  userId: string;
  threadId: string;
  server: string;
  // The fields of an external-secrets request (stored in the row for the
  // form); an OAuth client request has the fixed two.
  fields?: ExternalServerSecretField[];
};

type RequestRow = { id: string; userId: string; threadId: string | null; server: string; createdAt: Date };

export function secretRequestRecord(row: RequestRow, fields: readonly string[]): SecretRequestRecord {
  return { requestId: row.id, server: row.server, fields: [...fields], requestedAt: row.createdAt.toISOString() };
}

// Opens (or replaces) the request of one server for one user and journals
// it; answers the row's id — the address of the one-time link.
export async function openSecretRequest(kind: SecretRequestKind, input: OpenSecretRequestInput): Promise<{ id: string }> {
  const { userId, threadId, server } = input;
  // nonce/expiresAt are vestigial: the session flow never reads them. They
  // stay written (columns are required) until a later cleanup migration
  // drops them once no running code references them. createdAt is the
  // moment of this request: a replacement is a new request in the same row.
  const stamp = () => ({ nonce: randomToken(), expiresAt: new Date(), createdAt: new Date() });

  return registryMutation(async (tx, journal) => {
    if (kind === 'external-secrets') {
      const fields = (input.fields ?? []) as unknown as Prisma.InputJsonValue;
      const row = await tx.externalServerSecretRequest.upsert({
        where: { userId_server: { userId, server } },
        create: { userId, threadId, server, fields, ...stamp() },
        update: { threadId, fields, ...stamp() },
      });

      await journal(SECRETS_REQUESTED, secretRequestRecord(row, (input.fields ?? []).map(field => field.key)), { kind: 'thread', userId, threadId });

      return { id: row.id };
    }

    const row = await tx.oauthClientRequest.upsert({
      where: { userId_server: { userId, server } },
      create: { userId, threadId, server, ...stamp() },
      update: { threadId, ...stamp() },
    });

    await journal(OAUTH_CLIENT_REQUESTED, secretRequestRecord(row, OAUTH_CLIENT_FIELDS), { kind: 'thread', userId, threadId });

    return { id: row.id };
  });
}

function randomToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}

function fieldNames(value: unknown): string[] {
  return Array.isArray(value) ? value.map(field => (field && typeof field === 'object' && typeof field.key === 'string' ? field.key : null)).filter((key): key is string => key !== null) : [];
}

// The open requests of a user as the snapshot shows them, oldest first
// (ties by id): both tables, with the agent of the issuing thread.
export async function readOpenSecretRequests(userId: string, client: Tx | typeof prisma = prisma): Promise<OpenSecretRequestView[]> {
  const [secrets, clients] = await Promise.all([
    client.externalServerSecretRequest.findMany({ where: { userId } }),
    client.oauthClientRequest.findMany({ where: { userId } }),
  ]);
  const rows: Array<Omit<OpenSecretRequestView, 'agent'>> = [
    ...secrets.map(row => ({ id: row.id, kind: 'external-secrets' as const, server: row.server, fields: fieldNames(row.fields), threadId: row.threadId, requestedAt: row.createdAt })),
    ...clients.map(row => ({ id: row.id, kind: 'oauth-client' as const, server: row.server, fields: [...OAUTH_CLIENT_FIELDS], threadId: row.threadId, requestedAt: row.createdAt })),
  ];
  const threadIds = [...new Set(rows.map(row => row.threadId).filter((id): id is string => id !== null))];
  const threads = threadIds.length ? await client.thread.findMany({ where: { id: { in: threadIds } }, select: { id: true, agent: true } }) : [];
  const agents = new Map(threads.map(thread => [thread.id, thread.agent]));

  return rows
    .map(row => ({ ...row, agent: row.threadId ? (agents.get(row.threadId) ?? null) : null }))
    .sort((a, b) => a.requestedAt.getTime() - b.requestedAt.getTime() || a.id.localeCompare(b.id));
}
