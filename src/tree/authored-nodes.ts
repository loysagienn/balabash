// Installation modules receive the running bundle's catalog constructors.
// In particular, named types and CapabilityError belong to that instance.
import { isAsyncFunction } from 'node:util/types';
import path from 'node:path';
import { z } from 'zod';
import {
  Account, accountAuthority, capability, CapabilityError, FileId, FileRef, JsonObject, JsonValue,
  namedType, node, secretAuthority, withNamedTypes,
  type CallContext, type Node, type NodeDefinition, type Vertex,
} from '../catalog/index.ts';
import { extensionFilesApi } from '../files/index.ts';
import { fileRefValue, storedFile } from './files.ts';
import { warnRecipients } from '../capabilities/agent-catalog.ts';
import { INSTALLATION_NODES_DIR, importExtensionModule, listExtensionFiles, reportSkippedExtension, type ReportExtensionFailure } from '../capabilities/extensions.ts';

const api = {
  z, node, capability, namedType, CapabilityError, accountAuthority, secretAuthority,
  Account, FileId, FileRef, JsonObject, JsonValue,
  files: {
    async ingest({ caller, signal }: CallContext, input: Pick<Parameters<typeof extensionFilesApi.ingest>[0],
      'body' | 'originalFilename' | 'contentType' | 'sizeBytes'>) {
      return fileRefValue(await extensionFilesApi.ingest({ ...input, workspaceId: caller.workspaceId, scope: 'workspace', signal: signal ?? undefined }));
    },
    async open({ caller }: CallContext, fileId: string) {
      return extensionFilesApi.open((await storedFile(caller, fileId)).id);
    },
  },
};
export type DefineInstallationNode = (catalog: typeof api) =>
  Omit<NodeDefinition, 'name' | 'installation'> & { recipients?: string[] };

function validateVertex(vertex: Vertex, fullName: string, services: ReadonlySet<string>): void {
  if (services.has(fullName)) throw new Error(`"${fullName}" conflicts with a configured installation service`);
  if (vertex.kind === 'node') {
    if (vertex.connection && services.has(vertex.connection.service)) {
      throw new Error(`Service "${vertex.connection.service}" of "${fullName}" is already configured`);
    }
    for (const child of vertex.children) {
      if (child.kind === 'node' && child.installation) throw new Error('Only the top-level node declares installation metadata');
      validateVertex(child, fullName + '_' + child.name, services);
    }
  } else if (vertex.kind !== 'capability' || vertex.serverSchemas || typeof vertex.run !== 'function') {
    throw new Error('Expected an authored node or capability with a run function');
  }
}

export async function loadAuthoredNodes(publish: (node: Node) => void, services: ReadonlySet<string>, report?: ReportExtensionFailure): Promise<void> {
  for (const file of await listExtensionFiles(INSTALLATION_NODES_DIR, '.ts')) {
    try {
      const module = await importExtensionModule(path.join(INSTALLATION_NODES_DIR, file));
      if (typeof module.define !== 'function') throw new Error('Expected an exported define(catalog) function');
      if (isAsyncFunction(module.define)) throw new Error('define must return the node synchronously');
      const define = module.define as DefineInstallationNode;
      withNamedTypes(() => {
        const result = define(api);
        if (result instanceof Promise) {
          void result.catch(() => {});
          throw new Error('define must return the node synchronously');
        }
        if (!Array.isArray(result?.children)) throw new Error('define must return a node with a children array');
        const { recipients = [], ...definition } = result;
        if (!Array.isArray(recipients) || recipients.some(name => typeof name !== 'string' || !name.trim())) {
          throw new Error('recipients must be an array of agent or profile names');
        }
        const name = path.basename(file, '.ts');
        const root = node({ ...definition, name, installation: { source: 'authored', recipients, revision: '' } });
        validateVertex(root, name, services);
        publish(root);
        warnRecipients(`[nodes] ${file}`, recipients);
      });
    } catch (error) {
      await reportSkippedExtension('nodes', file, error, report);
    }
  }
}
