// Installation modules receive the running bundle's catalog constructors.
// In particular, named types and CapabilityError belong to that instance.
import { createHash } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import {
  Account, accountAuthority, capability, CapabilityError, FileId, FileRef, JsonObject, JsonValue,
  namedType, node, secretAuthority, WorkspacePath,
  type Catalog, type CatalogVertex, type Node, type NodeDefinition, type Vertex,
} from '../catalog/index.ts';
import { withNamedTypes } from '../catalog/types.ts';
import { INSTALLATION_NODES_DIR, importExtensionModule, listExtensionFiles } from '../capabilities/extensions.ts';

const api = {
  z, node, capability, namedType, CapabilityError, accountAuthority, secretAuthority,
  Account, FileId, FileRef, JsonObject, JsonValue, WorkspacePath,
};
export type DefineInstallationNode = (catalog: typeof api) =>
  Omit<NodeDefinition, 'name' | 'installation'> & { recipients?: string[] };

// A restart can resume an opening from a previous process. Hash the actual
// published contract, including types imported from a module's helper files.
export function authoredRevision(root: CatalogVertex, catalog: Catalog, configuredServices: ReadonlySet<string>): string {
  const hash = createHash('sha256');
  function visit(vertex: CatalogVertex): void {
    if (configuredServices.has(vertex.fullName)) {
      throw new Error(`"${vertex.fullName}" conflicts with a configured installation service`);
    }
    if (vertex.kind === 'node' && vertex.connection && configuredServices.has(vertex.connection.service)) {
      throw new Error(`Service "${vertex.connection.service}" of "${vertex.fullName}" is already configured`);
    }
    const contract = vertex.kind === 'node'
      ? [vertex.fullName, vertex.summary, vertex.guide, vertex.connection]
      : [vertex.fullName, vertex.summary, vertex.description, vertex.input, vertex.output, vertex.inputRules,
          vertex.types.map(name => catalog.types.get(name))];
    hash.update(JSON.stringify(contract));
    if (vertex.kind === 'node') vertex.children.forEach(visit);
  }
  visit(root);
  return hash.digest('hex');
}

function validateChildren(children: Vertex[]): void {
  for (const child of children) {
    if (child.kind === 'node' && !child.installation) {
      validateChildren(child.children);
    } else if (child.kind !== 'capability' || child.serverSchemas || typeof child.run !== 'function') {
      throw new Error('Expected an authored node or capability with a run function');
    }
  }
}

export async function loadAuthoredNodes(publish: (node: Node) => void): Promise<void> {
  for (const file of await listExtensionFiles(INSTALLATION_NODES_DIR, '.ts')) {
    try {
      const module = await importExtensionModule(path.join(INSTALLATION_NODES_DIR, file));
      if (typeof module.define !== 'function') throw new Error('Expected an exported define(catalog) function');
      const define = module.define as DefineInstallationNode;
      withNamedTypes(() => {
        const { recipients = [], ...definition } = define(api);
        if (!Array.isArray(recipients) || recipients.some(name => typeof name !== 'string' || !name.trim())) {
          throw new Error('recipients must be an array of agent or profile names');
        }
        validateChildren(definition.children);
        publish(node({ ...definition, name: path.basename(file, '.ts'),
          installation: { source: 'authored', recipients, revision: '' } }));
        if (!recipients.length) console.warn(`[nodes] ${file} has no agent recipients`);
      });
    } catch (error) {
      console.error(`[nodes] ${file} skipped:`, error instanceof Error ? error.message : error);
    }
  }
}
