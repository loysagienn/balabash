// Installation credentials for external MCP servers (§10): every
// ${secret:NAME} reference is provisioned through a one-time web form —
// values go straight to the database, never through the chat, the model or
// the log (§2 ставка 4). The log records only the fact: a sanitized
// secrets.provisioned event addressed to the thread that issued the link.

import crypto from 'node:crypto';
import { prisma } from '../db/client.ts';
import { appendEvent } from '../core/append.ts';
import { SECRETS_PROVISIONED } from '../core/envelope.ts';
import { config } from '../config/index.ts';
import { listExternalSecretTargets, type ExternalSecretTarget } from './tool-manager.ts';

const SECRET_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type ExternalServerSecretField = {
  key: string;
  description: string;
};

function toFields(target: ExternalSecretTarget): ExternalServerSecretField[] {
  return target.secretNames.map(key => ({
    key,
    description: `Value for \${secret:${key}} in ${target.name}.json`,
  }));
}

function getTarget(serverName: string): ExternalSecretTarget | null {
  return listExternalSecretTargets().find(target => target.name === serverName) ?? null;
}

function randomToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}

function parseFields(value: unknown): ExternalServerSecretField[] {
  if (!Array.isArray(value)) {
    throw new Error('External server credential request has invalid fields');
  }

  return value.map(field => {
    if (
      !field ||
      typeof field !== 'object' ||
      Array.isArray(field) ||
      typeof field.key !== 'string' ||
      !SECRET_KEY_PATTERN.test(field.key) ||
      typeof field.description !== 'string'
    ) {
      throw new Error('External server credential request has an invalid field');
    }

    return { key: field.key, description: field.description };
  });
}

// Records a pending request and returns the operator's link into the web
// interface. The page behind it lives behind the SESSION — the request id in
// the URL is an address, not a credential; ownership is checked at the API
// edge. The request lives until fulfilled or replaced — no TTL. threadId is
// the issuing thread (the auth agent's): the provisioning event is addressed
// to it.
export async function requestExternalServerCredentials(
  userId: string,
  threadId: string,
  serverName: string,
): Promise<string> {
  const target = getTarget(serverName);

  if (!target) {
    throw new Error(`External server "${serverName}" is not awaiting installation credentials`);
  }

  const fields = toFields(target);
  // nonce/expiresAt are vestigial: the session flow never reads them. They
  // stay written (columns are required) until a later cleanup migration
  // drops them once no running code references them.
  const vestigial = { nonce: randomToken(), expiresAt: new Date() };

  const row = await prisma.externalServerSecretRequest.upsert({
    where: { userId_server: { userId, server: target.name } },
    create: { userId, threadId, server: target.name, fields, ...vestigial },
    update: { threadId, fields, ...vestigial },
  });

  return `https://${config.domain}/secrets/${row.id}`;
}

export type ExternalServerSecretRequestView = {
  id: string;
  server: string;
  fields: ExternalServerSecretField[];
};

// The request as the web window may see it: field METADATA only, never
// values. userId comes from the session; a foreign or missing request is the
// caller's 404. The live tool-manager is deliberately not consulted here —
// the row itself is the source of truth until fulfilled.
export async function getExternalServerSecretRequest(
  userId: string,
  requestId: string,
): Promise<ExternalServerSecretRequestView | null> {
  const row = await prisma.externalServerSecretRequest.findUnique({ where: { id: requestId } });

  if (!row || row.userId !== userId) {
    return null;
  }

  return { id: row.id, server: row.server, fields: parseFields(row.fields) };
}

export async function provisionExternalServerSecrets(
  userId: string,
  requestId: string,
  values: Record<string, string>,
): Promise<void> {
  const request = await getExternalServerSecretRequest(userId, requestId);

  if (!request) {
    throw new Error('The credential request does not exist or is already fulfilled');
  }

  const expected = new Set(request.fields.map(field => field.key));
  const normalized: Record<string, string> = {};

  for (const key of expected) {
    const value = values[key] ?? '';

    if (!value.trim()) {
      throw new Error(`Value for "${key}" is required`);
    }

    normalized[key] = value;
  }

  if (Object.keys(values).some(key => !expected.has(key))) {
    throw new Error('External server credential form contains an unexpected field');
  }

  // Consume atomically: the request row dies with the secrets landing. The
  // log event goes through the append API afterwards — if that append fails,
  // the state is still consistent: the manager reconnects the server on the
  // next secretVersion check regardless of the event.
  const consumed = await prisma.$transaction(async tx => {
    const row = await tx.externalServerSecretRequest.findUnique({ where: { id: request.id } });

    if (!row || row.userId !== userId) {
      throw new Error('The credential request does not exist or is already fulfilled');
    }

    await tx.externalServerSecretRequest.delete({ where: { id: row.id } });

    for (const [key, value] of Object.entries(normalized)) {
      await tx.externalServerSecret.upsert({
        where: { server_key: { server: row.server, key } },
        create: { server: row.server, key, value },
        update: { value },
      });
    }

    return row;
  });

  // Sanitized fact for the log: field names only, addressed to the issuing
  // thread (§4.2); append redirects to the main thread when it is gone.
  await appendEvent({
    type: SECRETS_PROVISIONED,
    actor: 'system',
    userId: consumed.userId,
    threadId: null,
    targetThreadId: consumed.threadId,
    payload: { server: consumed.server, fields: Object.keys(normalized) },
  }).catch(error => {
    console.error(`[secrets] failed to journal provisioning for "${consumed.server}":`, error);
  });
}
