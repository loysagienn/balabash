// Provider identity of a connection: the provider's own answer to "who is
// authorized here", fetched by the platform with an access token through the
// probe the service declared. Identity is the twin guard and the precondition
// for holding multiple accounts of one service; it is never an address (the
// slug is) and never proof of authorization (tokens are).

import { Prisma } from '../../../prisma-generated/client.ts';
import { prisma } from '../../db/client.ts';
import type { IdentityProbeConfig } from '../server-config.ts';

export type ProbedIdentity = { id: string; label: string | null };

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function getAccessToken(tokens: unknown): string | null {
  return isObject(tokens) && typeof tokens.access_token === 'string' && tokens.access_token
    ? tokens.access_token
    : null;
}

// The probe runs on hot paths (OAuth callback, lazy backfill around turn
// start) — a hung provider must not hang them.
const PROBE_TIMEOUT_MS = 10_000;

export async function probeIdentity(probe: IdentityProbeConfig, accessToken: string): Promise<ProbedIdentity> {
  const response = await fetch(probe.url, {
    headers: { Authorization: `${probe.authScheme ?? 'Bearer'} ${accessToken}` },
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`identity probe answered ${response.status}`);
  }

  const body: unknown = await response.json().catch(() => {
    throw new Error('identity probe answered non-JSON');
  });
  const rawId = isObject(body) ? body[probe.idField] : undefined;
  const id = typeof rawId === 'string' ? rawId : typeof rawId === 'number' ? String(rawId) : '';

  if (!id) {
    throw new Error(`identity probe response has no "${probe.idField}"`);
  }

  const rawLabel = probe.labelField && isObject(body) ? body[probe.labelField] : undefined;

  return { id, label: typeof rawLabel === 'string' && rawLabel ? rawLabel : null };
}

// The identity column value: machine id + human label. The label feeds every
// display surface (tool schemas, teaching errors, sickness reports).
export function identityData(identity: ProbedIdentity): Prisma.InputJsonValue {
  return { id: identity.id, label: identity.label, probedAt: new Date().toISOString() };
}

// The one reader of the identity JSON shape (owned by identityData above):
// the human label of a connection row's recorded identity, or null.
export function identityLabel(identity: unknown): string | null {
  const label = isObject(identity) ? identity.label : null;

  return typeof label === 'string' && label ? label : null;
}

// Lazy backfill for a pre-multi-account row without identity: probe with the
// stored access token and record the answer. Refuses to write a twin (two
// rows claiming one provider account) — that conflict is surfaced to the
// caller, never resolved silently here.
export async function backfillConnectionIdentity(
  probe: IdentityProbeConfig,
  connectionId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const row = await prisma.connection.findUnique({ where: { id: connectionId } });

  if (!row) {
    return { ok: false, reason: 'connection no longer exists' };
  }

  if (row.identityId) {
    return { ok: true };
  }

  const accessToken = getAccessToken(row.tokens);

  if (!accessToken) {
    return { ok: false, reason: 'no stored access token' };
  }

  let identity: ProbedIdentity;

  try {
    identity = await probeIdentity(probe, accessToken);
  } catch (error) {
    return { ok: false, reason: getErrorMessage(error) };
  }

  const twin = await prisma.connection.findFirst({
    where: { userId: row.userId, server: row.server, identityId: identity.id, NOT: { id: row.id } },
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
