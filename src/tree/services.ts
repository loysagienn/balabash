// The services of the tree and the connections port of the catalog: where
// the connections a node declares meet the app's connections layer
// (src/capabilities/connections, the installation secrets next to it).
//
// A service is defined by its node: the node's connection says how the
// service is connected. The layer keeps the state under the service's name —
// the accounts of a workspace with their tokens, the OAuth client and the
// secrets of the installation — and runs the authorization. registerServices
// tells the layer about every service of a catalog; connectionsPort is what
// the catalog core asks: which accounts there are, whether the secrets are
// in place, and the authority a call acts with.

import {
  CapabilityError,
  type AccountAuthority,
  type AccountValue,
  type Catalog,
  type ConnectionsPort,
  type SecretAuthority,
  type SecretConnection,
} from '../catalog/index.ts';
import { accountAccessToken, listAccounts } from '../capabilities/connections/index.ts';
import { identityLabel } from '../capabilities/connections/identity.ts';
import { AuthorizationLostError, OauthClientError } from '../capabilities/connections/oauth-provider.ts';
import {
  getAccountService,
  registerAccountService,
  registerSecretServiceSource,
  type AccountService,
  type SecretService,
} from '../capabilities/connections/services.ts';
import { prisma } from '../db/client.ts';

// ---------------------------------------------------------------------------
// The services of the tree

// The secret services of the tree, and whether the secrets of each are
// stored — as of the last refresh.
const secretServices = new Map<string, SecretConnection>();
let stored = new Set<string>();
let sourceRegistered = false;

// The secrets a service has refused: what it said and when. A node keeps no
// connection to its service between calls, so the last attempt a service is
// known by is the last call that showed its secrets to it. Kept in memory: a
// restart forgets it, and the next call says it again.
const refused = new Map<string, { reason: string; at: number }>();

// A node tells how the service took the secrets of a call: refused them, or
// let the call in.
export function secretsRefused(service: string, reason: string): void {
  refused.set(service, { reason, at: Date.now() });
}

export function secretsAccepted(service: string): void {
  refused.delete(service);
}

async function storedSecrets(service: string): Promise<Map<string, Date>> {
  const rows = await prisma.externalServerSecret.findMany({
    where: { server: service },
    select: { key: true, updatedAt: true },
  });

  return new Map(rows.map(row => [row.key, row.updatedAt]));
}

async function refreshStoredSecrets(): Promise<void> {
  const next = new Set<string>();

  for (const connection of secretServices.values()) {
    const secrets = await storedSecrets(connection.service);
    const refusal = refused.get(connection.service);

    if (connection.secrets.every(name => secrets.has(name))) {
      next.add(connection.service);
    }

    // A refusal is of the values it was given: secrets entered since, or
    // deleted, are not the refused ones.
    if (refusal && !connection.secrets.every(name => (secrets.get(name)?.getTime() ?? Infinity) <= refusal.at)) {
      refused.delete(connection.service);
    }
  }

  stored = next;
}

// The secret services of the tree join the other holders of installation
// secrets (the kinds of remote agents) in the one list of the connections
// layer, which the secrets form, the Connections page and `connections_list`
// read.
function secretServiceStates(): SecretService[] {
  return [...secretServices.values()].map(connection => {
    const refusal = refused.get(connection.service);

    return {
      name: connection.service,
      description: connection.summary,
      secretNames: [...connection.secrets],
      connected: stored.has(connection.service) && !refusal,
      error: refusal?.reason ?? null,
    };
  });
}

// Tells the connections layer about every service the catalog declares. The
// catalog of the installation is registered once, when it is built; a
// service registered again is replaced.
export function registerServices(catalog: Catalog): void {
  for (const vertex of catalog.vertices.values()) {
    const connection = vertex.kind === 'node' ? vertex.connection : null;

    if (connection?.type === 'account') {
      registerAccountService({
        name: connection.service,
        url: connection.oauth.url,
        description: connection.summary,
        setup: connection.setup ?? null,
        clientRegistration: connection.oauth.clientRegistration,
        scope: connection.oauth.scope ?? null,
        authorizationParams: connection.oauth.authorizationParams ?? null,
        identityProbe: connection.oauth.identityProbe ?? null,
      });
    }

    if (connection?.type === 'secret') {
      secretServices.set(connection.service, connection);
    }
  }

  if (secretServices.size && !sourceRegistered) {
    sourceRegistered = true;
    registerSecretServiceSource({ list: secretServiceStates, refresh: refreshStoredSecrets });
  }
}

// ---------------------------------------------------------------------------
// The port

type AccountRow = { accountKey: string; displayName: string; identity: unknown; status: string };

// An account as the catalog shows it: never its tokens. `identity` is the
// label the provider gave.
export function accountValue(account: string, name: string, identity: string | null, status: string): AccountValue {
  return {
    account,
    name,
    identity,
    status: status === 'connected' || status === 'pending' ? status : 'reauthorization_required',
  };
}

// The same of a row of the layer.
export function accountOf(row: AccountRow): AccountValue {
  return accountValue(row.accountKey, row.displayName, identityLabel(row.identity), row.status);
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// The access token of the account for one call of the provider. An account
// whose authorization is gone answers auth_required; the layer has marked
// it for re-authorization, and the thread that connected it got the event.
async function accessToken(
  service: AccountService,
  row: { id: string; server: string; accountKey: string },
  rejected?: string,
): Promise<string> {
  try {
    return await accountAccessToken(row, service.url, rejected);
  } catch (error) {
    if (error instanceof AuthorizationLostError) {
      throw new CapabilityError(
        'auth_required',
        `The account "${row.accountKey}" of "${service.name}" can no longer act: ${error.message}. The user has to authorize it again.`,
      );
    }

    // The client is the installation's, not the account's: the account stays
    // as it is and acts again once the client is put right.
    if (error instanceof OauthClientError) {
      throw new CapabilityError(
        'auth_required',
        `No account of "${service.name}" can renew its access: ${error.message}. The operator has to put the OAuth client of the installation right; the account "${row.accountKey}" stays connected.`,
      );
    }

    throw new CapabilityError(
      'unavailable',
      `The access token of the account "${row.accountKey}" of "${service.name}" could not be renewed: ${reason(error)}`,
    );
  }
}

async function accountAuthority(workspaceId: string, name: string, account: string): Promise<AccountAuthority> {
  const service = getAccountService(name);
  const row = await prisma.connection.findUnique({
    where: { workspaceId_server_accountKey: { workspaceId, server: name, accountKey: account } },
    select: { id: true, server: true, accountKey: true, status: true },
  });

  if (!service || !row || row.status !== 'connected') {
    throw new CapabilityError(
      'auth_required',
      `The account "${account}" of "${name}" is not connected: the user has to authorize it.`,
    );
  }

  return { type: 'account', accessToken: rejected => accessToken(service, row, rejected) };
}

async function secretAuthority(name: string): Promise<SecretAuthority> {
  const connection = secretServices.get(name);
  const rows = connection ? await prisma.externalServerSecret.findMany({ where: { server: name } }) : [];
  const values = new Map(rows.map(row => [row.key, row.value]));
  const missing = connection?.secrets.filter(secret => !values.has(secret)) ?? [];

  if (!connection || missing.length) {
    throw new CapabilityError(
      'auth_required',
      `The installation secrets of "${name}" are not entered${missing.length ? ` (${missing.join(', ')})` : ''}: the operator has to enter them.`,
    );
  }

  return { type: 'secret', secrets: Object.fromEntries(connection.secrets.map(secret => [secret, values.get(secret)!])) };
}

// The connections port over the app's connections layer. It knows the
// services registered with the layer; a service nobody registered has no
// accounts and no secrets.
export function connectionsPort(): ConnectionsPort {
  return {
    async accounts(workspaceId, service) {
      return (await listAccounts(workspaceId, service)).map(accountOf);
    },
    async secretsReady(service) {
      const connection = secretServices.get(service);

      if (!connection) {
        return false;
      }

      const secrets = await storedSecrets(service);

      return connection.secrets.every(name => secrets.has(name));
    },
    accountAuthority,
    secretAuthority,
  };
}
