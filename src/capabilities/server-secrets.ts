// ${secret:NAME} references in external server configs (§10). Secret values
// live only in the external_server_secrets table (server-scoped, provisioned
// through one-time web forms — §2 ставка 4) and are resolved into a config
// right before connecting; they never appear in the log or the model context.

import { prisma } from '../db/client.ts';
import type { ExternalServerConfig } from './server-config.ts';

const SECRET_REFERENCE_PATTERN = /\$\{secret:([A-Za-z_][A-Za-z0-9_]*)\}/g;

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function resolveSecretReferences<T>(value: T, secrets: Record<string, string | undefined>): T {
  if (typeof value === 'string') {
    return value.replace(SECRET_REFERENCE_PATTERN, (_match, name: string) => {
      const secret = secrets[name];

      if (secret === undefined) {
        throw new Error(`Installation credential "${name}" referenced as \${secret:${name}} is not set`);
      }

      return secret;
    }) as T;
  }

  if (Array.isArray(value)) {
    return value.map(item => resolveSecretReferences(item, secrets)) as T;
  }

  if (isObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, resolveSecretReferences(item, secrets)]),
    ) as T;
  }

  return value;
}

export function getSecretReferenceNames(value: unknown): string[] {
  const names = new Set<string>();

  const visit = (item: unknown): void => {
    if (typeof item === 'string') {
      for (const match of item.matchAll(SECRET_REFERENCE_PATTERN)) {
        names.add(match[1]);
      }
      return;
    }

    if (Array.isArray(item)) {
      item.forEach(visit);
      return;
    }

    if (isObject(item)) {
      Object.values(item).forEach(visit);
    }
  };

  visit(value);

  return [...names].sort();
}

export type ResolvedExternalServerSecrets = {
  // null: at least one referenced secret is missing — the server stays pending.
  config: ExternalServerConfig | null;
  secretNames: string[];
  // Stable fingerprint of the used secret rows; a change means the secrets
  // were re-provisioned and the server must reconnect.
  secretVersion: string | null;
};

export async function resolveExternalServerSecrets(
  serverName: string,
  config: ExternalServerConfig,
): Promise<ResolvedExternalServerSecrets> {
  const secretNames = getSecretReferenceNames(config);

  if (!secretNames.length) {
    return { config, secretNames, secretVersion: null };
  }

  const rows = await prisma.externalServerSecret.findMany({ where: { server: serverName } });
  const secrets = Object.fromEntries(rows.map(row => [row.key, row.value]));

  if (secretNames.some(name => secrets[name] === undefined)) {
    return { config: null, secretNames, secretVersion: null };
  }

  const secretVersion = rows
    .filter(row => secretNames.includes(row.key))
    .sort((left, right) => left.key.localeCompare(right.key))
    .map(row => `${row.key}:${row.updatedAt.getTime()}`)
    .join('|');

  return {
    config: resolveSecretReferences(config, secrets),
    secretNames,
    secretVersion,
  };
}
