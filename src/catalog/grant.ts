// The grant: the catalog for one caller — the common tree with vertices cut
// off for this agent and for what is connected in the workspace. A grant
// only cuts; which of the remaining vertices are open is the business of the
// core in the prompt and of `describe`.
//
// - The capabilities of the root are cut one by one. Below the root a leaf is
//   never cut alone: the capabilities of a node come together.
// - A node whose connection is not in place is cut whatever the policy says:
//   an account connection needs a connected account in the workspace, a
//   secret connection needs the installation's secrets.
// - A recipe of a guide is shown only when the caller has everything it
//   requires.
//
// A grant belongs to its caller and carries it: what `describe` shows, which
// account a call acts as and whom the action runs for are all read from the
// one grant, so they cannot come from different callers.

import type { ActionName } from './actions.ts';
import type { Catalog, CatalogNode, CatalogVertex } from './catalog.ts';
import type { Caller } from './definition.ts';
import type { AccountValue } from './types.ts';

// What the catalog needs to know about connections; the platform's
// connections layer stands behind it.
export type ConnectionsPort = {
  // The accounts of an account service in the workspace, whatever their
  // status.
  accounts(workspaceId: string, service: string): Promise<AccountValue[]>;
  // Whether the installation's secrets of a secret service are in place.
  secretsReady(service: string): Promise<boolean>;
};

export type GrantPolicy = {
  // Asked for every capability of the root and for every node whose parent
  // is granted; never for a capability below the root.
  allows(vertex: CatalogVertex): boolean;
  // The actions the caller's port gives.
  actions: readonly ActionName[];
};

export type Grant = {
  catalog: Catalog;
  // Whose grant it is: the one the policy was asked about, the one every
  // call under this grant is made on behalf of.
  caller: Caller;
  actions: ReadonlySet<ActionName>;
  // Full names of the granted vertices; the root ('') is always there.
  vertices: ReadonlySet<string>;
};

async function connectionInPlace(
  node: CatalogNode,
  workspaceId: string,
  connections: ConnectionsPort,
): Promise<boolean> {
  if (!node.connection) {
    return true;
  }

  if (node.connection.type === 'secret') {
    return connections.secretsReady(node.connection.service);
  }

  return (await connections.accounts(workspaceId, node.connection.service)).some(
    account => account.status === 'connected',
  );
}

export async function computeGrant(
  catalog: Catalog,
  policy: GrantPolicy,
  env: { caller: Caller; connections: ConnectionsPort },
): Promise<Grant> {
  const vertices = new Set<string>(['']);

  const visit = async (node: CatalogNode): Promise<void> => {
    for (const child of node.children) {
      if (child.kind === 'capability') {
        if (node.parent !== null || policy.allows(child)) {
          vertices.add(child.fullName);
        }

        continue;
      }

      if (policy.allows(child) && (await connectionInPlace(child, env.caller.workspaceId, env.connections))) {
        vertices.add(child.fullName);
        await visit(child);
      }
    }
  };

  await visit(catalog.root);

  return { catalog, caller: { ...env.caller }, actions: new Set(policy.actions), vertices };
}

export function grantedVertex(grant: Grant, fullName: string): CatalogVertex | null {
  return grant.vertices.has(fullName) ? (grant.catalog.vertices.get(fullName) ?? null) : null;
}

export function grantedChildren(grant: Grant, node: CatalogNode): CatalogVertex[] {
  return node.children.filter(child => grant.vertices.has(child.fullName));
}

// The recipes of a node the caller can follow: every capability and action a
// recipe requires is in the grant.
export function grantedGuide(grant: Grant, node: CatalogNode): string[] {
  return node.guide
    .filter(recipe =>
      (recipe.requires ?? []).every(name => grant.vertices.has(name) || grant.actions.has(name as ActionName)),
    )
    .map(recipe => recipe.text);
}

// The deepest granted node on the path a name points along — what an answer
// to a wrong name sends the caller to. The root when nothing closer exists.
export function nearestNode(grant: Grant, name: string): CatalogNode {
  const segments = name.split('_');

  for (let length = segments.length; length > 0; length -= 1) {
    const vertex = grantedVertex(grant, segments.slice(0, length).join('_'));

    if (vertex?.kind === 'node') {
      return vertex;
    }
  }

  return grant.catalog.root;
}

// How a name that leads nowhere is answered: the nearest node the caller
// does have, to describe next.
export function nearestNodeHint(grant: Grant, name: string): string {
  const nearest = nearestNode(grant, name);

  return nearest.fullName
    ? `The nearest node you have is \`${nearest.fullName}\`: describe it to see what is there.`
    : 'Describe the root (no name) to see what you have.';
}

// The connection a vertex works under: its own, or of the nearest node up
// the path.
export function connectionNodeOf(vertex: CatalogVertex): CatalogNode | null {
  if (vertex.kind === 'capability') {
    return vertex.connectionNode;
  }

  for (let node: CatalogNode | null = vertex; node; node = node.parent) {
    if (node.connection) {
      return node;
    }
  }

  return null;
}
