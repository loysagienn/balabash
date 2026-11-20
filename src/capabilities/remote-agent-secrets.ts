// The database side of the remote agent kinds (remote-agent-source.ts): the
// driver context of a kind — its installation secrets (ExternalServerSecret
// rows with server = the kind's name) and the files surface — and the kinds
// with secrets as installation services. Like an external MCP server with
// ${secret:NAME} values, such a kind appears on the console's Connections
// page and in the auth agent's request_external_server_credentials through
// the source registered with the connections layer (connections/services.ts),
// and the secrets form stores the values under the kind's name.

import type { RemoteAgentDeclaration, RemoteDriverContext, RemoteDriverFilesApi } from '../core/contract.ts';
import { prisma } from '../db/client.ts';
import { getLoadedRemoteKinds } from './remote-agent-source.ts';
import { registerSecretServiceSource, type SecretService } from './connections/services.ts';

// The driver context of a kind over the live database and the files
// surface: secrets are the kind's ExternalServerSecret rows.
export function createRemoteDriverContext(kind: string, files: RemoteDriverFilesApi): RemoteDriverContext {
  return {
    secrets: {
      get: async name => {
        const row = await prisma.externalServerSecret.findUnique({ where: { server_key: { server: kind, key: name } } });

        if (!row) {
          throw new Error(`secret ${name} is not provisioned for ${kind}`);
        }

        return row.value;
      },
    },
    files,
  };
}

// ---------------------------------------------------------------------------
// The kinds with secrets as installation services: a source of the
// connections layer. `connected` = every declared secret has a value;
// refreshed whenever the layer is (the Connections page, provisioning,
// forgetting).

let secretTargets: SecretService[] = [];

export async function refreshRemoteSecretTargets(declarations: RemoteAgentDeclaration[] = getLoadedRemoteKinds()): Promise<void> {
  const withSecrets = declarations.filter(declaration => declaration.secrets?.length);

  if (!withSecrets.length) {
    secretTargets = [];

    return;
  }

  const rows = await prisma.externalServerSecret.findMany({
    where: { server: { in: withSecrets.map(declaration => declaration.name) } },
    select: { server: true, key: true },
  });
  const present = new Set(rows.map(row => `${row.server}\u0000${row.key}`));

  secretTargets = withSecrets.map(declaration => ({
    name: declaration.name,
    description: declaration.description,
    secretNames: [...declaration.secrets!],
    error: null,
    connected: declaration.secrets!.every(name => present.has(`${declaration.name}\u0000${name}`)),
  }));
}

export function registerRemoteSecretTargets(): void {
  registerSecretServiceSource({
    list: () => secretTargets,
    refresh: () => refreshRemoteSecretTargets(),
  });
}
