// The services of the installation as the connections layer knows them. The
// layer owns both registries and reads nothing else about a service; whoever
// defines a service tells it here — the tree of the capability catalog for a
// node with a connection (src/tree/services.ts), the kinds of remote agents
// for their secrets, tree/configured-servers.ts for installation MCP configs. A name has one
// definition: named again, it is replaced.
//
// - account services: what a user connects their own account to, and how
//   each of them authorizes;
// - installation services: what is connected once for everyone, by secrets
//   of the installation.

import type { IdentityProbeConfig } from '../server-config.ts';

export type AccountService = {
  // The key the accounts and the OAuth client of the service are stored
  // under.
  name: string;
  // Where the discovery of the authorization server starts: the protected
  // resource, when it names its authorization server itself (RFC 9728, an
  // MCP server), or the authorization server.
  url: string;
  // What the service gives, one line.
  description: string;
  // What the operator sets up at the provider before the first
  // authorization; null when nothing was written about it.
  setup: string | null;
  // dynamic: the provider registers the client itself; manual: the operator
  // enters the client of the installation.
  clientRegistration: 'dynamic' | 'manual';
  scope: string | null;
  authorizationParams: Record<string, string> | null;
  // Declared identity probe — the precondition for multiple accounts.
  identityProbe: IdentityProbeConfig | null;
};

const services = new Map<string, AccountService>();

export function registerAccountService(service: AccountService): void {
  services.set(service.name, service);
}

export function getAccountService(name: string): AccountService | null {
  return services.get(name) ?? null;
}

export function listAccountServices(): AccountService[] {
  return [...services.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Installation services

// A holder of installation secrets: the secrets it needs and how it stands.
export type SecretService = {
  // The key the secrets of the service are stored under.
  name: string;
  description: string | null;
  secretNames: string[];
  // connected: the secrets are stored and nothing is known against them;
  // otherwise `error` says what the service answered them with, and null
  // means they are not all entered.
  connected: boolean;
  error: string | null;
};

// Sources publish the latest state after a shared refresh.
export type SecretServiceSource = {
  list(): SecretService[];
  refresh(): Promise<void>;
};

const secretServiceSources: SecretServiceSource[] = [];

export function registerSecretServiceSource(source: SecretServiceSource): void {
  secretServiceSources.push(source);
}

export async function refreshSecretServices(): Promise<void> {
  for (const source of secretServiceSources) {
    await source.refresh();
  }
}

// One entry per name, as of the last refresh: a service two sources name is
// the one of the source registered later.
export function listSecretServices(): SecretService[] {
  const byName = new Map<string, SecretService>();

  for (const source of secretServiceSources) {
    for (const service of source.list()) {
      byName.set(service.name, service);
    }
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function getSecretService(name: string): SecretService | null {
  return listSecretServices().find(service => service.name === name) ?? null;
}
