// Provider identity of a connection: the provider's own answer to "who is
// authorized here", fetched by the platform with an access token through the
// probe the service declared. Identity is the twin guard and the precondition
// for holding multiple accounts of one service; it is never an address (the
// slug is) and never proof of authorization (tokens are).

import { Prisma } from '../../../prisma-generated/client.ts';
import { prisma } from '../../db/client.ts';
import type { IdentityProbeConfig } from '../server-config.ts';
import { connectionAccessToken } from './oauth-provider.ts';

export type ProbedIdentity = { id: string; label: string | null };

// A field of the probe's answer by its path: a top-level name, or a dotted
// path into nested objects ("user.emailAddress" — Drive's about resource
// wraps the account in "user"). Pure; undefined when the path breaks.
export function readField(body: unknown, path: string): unknown {
  let value: unknown = body;

  for (const segment of path.split('.')) {
    if (!isObject(value)) {
      return undefined;
    }

    value = value[segment];
  }

  return value;
}

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

// The probe runs on hot paths (the OAuth callback, the link for one more
// account) — a hung provider must not hang them.
const PROBE_TIMEOUT_MS = 10_000;

// The provider answered the probe with a refusal. 401 is of the token: a
// newer one may be let in.
export class ProbeRefusedError extends Error {
  status: number;

  constructor(status: number) {
    super(`identity probe answered ${status}`);
    this.status = status;
  }
}

export async function probeIdentity(probe: IdentityProbeConfig, accessToken: string): Promise<ProbedIdentity> {
  const response = await fetch(probe.url, {
    headers: { Authorization: `${probe.authScheme ?? 'Bearer'} ${accessToken}` },
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new ProbeRefusedError(response.status);
  }

  const body: unknown = await response.json().catch(() => {
    throw new Error('identity probe answered non-JSON');
  });
  const rawId = readField(body, probe.idField);
  const id = typeof rawId === 'string' ? rawId : typeof rawId === 'number' ? String(rawId) : '';

  if (!id) {
    throw new Error(`identity probe response has no "${probe.idField}"`);
  }

  const rawLabel = probe.labelField ? readField(body, probe.labelField) : undefined;

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

// Backfill for a row without identity — one connected before the service
// declared its probe, or one whose probe got no answer at the callback: ask
// the provider who the account is and record the answer. The account is
// asked the way a call of it acts: on its current access, renewed when it
// has expired or the provider refuses it — a row that has not been used
// since its token ran out is no reason to send the user to re-authorize.
// Refuses to write a twin (two rows claiming one provider account) — that
// conflict is surfaced to the caller, never resolved silently here.
export async function backfillConnectionIdentity(
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
    const accessToken = await connectionAccessToken(row, service.url);

    identity = await probeIdentity(service.identityProbe, accessToken).catch(async (error: unknown) => {
      if (!(error instanceof ProbeRefusedError) || error.status !== 401) {
        throw error;
      }

      return probeIdentity(service.identityProbe, await connectionAccessToken(row, service.url, accessToken));
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
