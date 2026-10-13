// Remote agent kinds of the installation (extensions.ts): every
// data/remote-agents/<name>.ts exports start(ctx) and returns a
// RemoteAgentDeclaration — the kind's name, description, launch-option
// schema, secrets and the driver that translates the external system into
// the dialogue vocabulary of src/core/contract.ts (the contract and the
// rules of a driver are written there). Loaded once at boot after the repository's
// agents; a module that fails to import, start or validate is skipped with
// a console error and one system.exception (scope 'remote-agents') — the
// installation's file is not the bundle's to roll back, so the boot goes on
// without the kind. A thread of a kind that did not load stays as it is:
// the remote engine leaves rows without a driver alone (src/remote).
//
// The driver context (secrets, files) and the kinds' place among the
// installation services live in remote-agent-secrets.ts — this module
// stays database-free (the loader is tested over temporary files alone).

import path from 'node:path';
import type { RemoteAgentDeclaration, RemoteDriverContext } from '../core/contract.ts';
import { INSTALLATION_REMOTE_AGENTS_DIR, importExtensionModule, listExtensionFiles } from './extensions.ts';
import { validateRemoteAgent } from './validate-agent.ts';

export type RemoteAgentLoadFailure = { file: string; error: string };

export type LoadRemoteAgentsInput = {
  directory?: string;
  // The context handed to start() and, later, to every driver verb of the
  // kind: the secrets of the kind and the files surface.
  context: (kind: string) => RemoteDriverContext;
  repositoryAgents: ReadonlySet<string>;
  // A module skipped: journaled by the caller (system.exception).
  report?: (failure: RemoteAgentLoadFailure) => Promise<void>;
};

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// The loaded kinds by name, with the context their drivers run in — the
// remote engine's lookup (a kind is loaded iff it is here).
const loadedKinds = new Map<string, { declaration: RemoteAgentDeclaration; context: RemoteDriverContext }>();

export function getLoadedRemoteKind(kind: string): { declaration: RemoteAgentDeclaration; context: RemoteDriverContext } | null {
  return loadedKinds.get(kind) ?? null;
}

export function getLoadedRemoteKinds(): RemoteAgentDeclaration[] {
  return [...loadedKinds.values()].map(entry => entry.declaration);
}

export async function loadRemoteAgents({
  directory = INSTALLATION_REMOTE_AGENTS_DIR,
  context,
  repositoryAgents,
  report,
}: LoadRemoteAgentsInput): Promise<RemoteAgentDeclaration[]> {
  const declarations: RemoteAgentDeclaration[] = [];
  const seen = new Set<string>();

  loadedKinds.clear();

  for (const file of await listExtensionFiles(directory, '.ts')) {
    const kind = path.basename(file, '.ts');
    const ctx = context(kind);

    try {
      const module = await importExtensionModule(path.join(directory, file));
      const exports = Object.keys(module);

      if (exports.length !== 1 || exports[0] !== 'start') {
        throw new Error(`${file} must export only "start"`);
      }

      if (typeof module.start !== 'function') {
        throw new Error(`${file} export "start" must be a function`);
      }

      const declaration = validateRemoteAgent(await module.start(ctx), file, repositoryAgents);

      if (seen.has(declaration.name)) {
        throw new Error(`${file} declares a remote agent already loaded`);
      }

      seen.add(declaration.name);
      declarations.push(declaration);
      loadedKinds.set(declaration.name, { declaration, context: ctx });
    } catch (error) {
      const message = getErrorMessage(error);

      console.error(`[remote-agents] ${file} skipped: ${message}`);
      await report?.({ file, error: message }).catch(reportError => {
        console.error(`[remote-agents] failed to journal the skip of ${file}:`, reportError);
      });
    }
  }

  if (declarations.length) {
    console.log(`[remote-agents] loaded: ${declarations.map(declaration => declaration.name).join(', ')}`);
  }

  return declarations;
}
