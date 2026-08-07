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

const LINK_TTL_MS = 15 * 60 * 1000;
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

// Issues a one-time link for the operator. threadId is the issuing thread
// (the auth agent's): the provisioning event is addressed to it.
export async function requestExternalServerCredentials(
  userId: string,
  threadId: string,
  serverName: string,
): Promise<string> {
  const target = getTarget(serverName);

  if (!target) {
    throw new Error(`External server "${serverName}" is not awaiting installation credentials`);
  }

  const nonce = randomToken();
  const fields = toFields(target);

  await prisma.externalServerSecretRequest.upsert({
    where: { userId_server: { userId, server: target.name } },
    create: {
      userId,
      threadId,
      server: target.name,
      nonce,
      fields,
      expiresAt: new Date(Date.now() + LINK_TTL_MS),
    },
    update: { threadId, nonce, fields, expiresAt: new Date(Date.now() + LINK_TTL_MS) },
  });

  return `https://${config.domain}/external-server-credentials/${target.name}?nonce=${nonce}`;
}

export type ExternalServerSecretRequestView = {
  server: string;
  nonce: string;
  fields: ExternalServerSecretField[];
};

export async function getExternalServerSecretRequest(
  serverName: string,
  nonce: string,
): Promise<ExternalServerSecretRequestView> {
  if (!getTarget(serverName) || !nonce) {
    throw new Error('External server credential link is malformed');
  }

  const row = await prisma.externalServerSecretRequest.findUnique({ where: { nonce } });

  if (!row || row.server !== serverName) {
    throw new Error('External server credential link is invalid or already used');
  }

  if (row.expiresAt.getTime() < Date.now()) {
    throw new Error('External server credential link has expired — ask for a new one in the chat');
  }

  return { server: row.server, nonce: row.nonce, fields: parseFields(row.fields) };
}

export async function provisionExternalServerSecrets(
  serverName: string,
  nonce: string,
  values: Record<string, string>,
): Promise<void> {
  const request = await getExternalServerSecretRequest(serverName, nonce);
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
    const row = await tx.externalServerSecretRequest.findUnique({ where: { nonce: request.nonce } });

    if (!row) {
      throw new Error('External server credential link is invalid or already used');
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
