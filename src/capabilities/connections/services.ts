// The account services of the installation: what a user can connect their
// own account to, and how each of them authorizes. The connections layer
// owns the registry and reads nothing else about a service; whoever defines
// a service registers it here — the tree of the capability catalog for a
// node with an account connection (src/tree/services.ts), the tool manager
// for a tool server with auth: "user".

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

// A name registered again is replaced: a service has one definition.
export function registerAccountService(service: AccountService): void {
  services.set(service.name, service);
}

export function unregisterAccountService(name: string): void {
  services.delete(name);
}

export function getAccountService(name: string): AccountService | null {
  return services.get(name) ?? null;
}

export function listAccountServices(): AccountService[] {
  return [...services.values()].sort((a, b) => a.name.localeCompare(b.name));
}
