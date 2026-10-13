// The agent catalog (§7.2): agents ship inside the app bundle through the
// static index — the import() machinery went away with hot-reload (the only
// reload is an app restart). Modules are still validated hard at boot: a
// broken declaration fails the start, and the supervisor rolls back to the
// last good bundle — failures are atomic instead of half-loaded.
//
// Remote agents (RemoteAgentDeclaration) join the same catalog from the
// installation's extensions (data/remote-agents, remote-agent-source.ts):
// loaded after the repository's agents, never shadowing them, and skipped
// loudly rather than failing the boot — an installation's file is not the
// bundle's to roll back.

import type { AgentDeclaration, RemoteAgentDeclaration } from '../core/contract.ts';
import { agentModules } from '../../agents/index.ts';
import { validateAgent } from './validate-agent.ts';

// Any agent of the catalog: a repository declaration (a session behind an
// SDK here) or a remote one (a session in an external system, mirrored).
export type CatalogAgent = AgentDeclaration | RemoteAgentDeclaration;

let agents = new Map<string, CatalogAgent>();

export function isRemoteAgent(agent: CatalogAgent): agent is RemoteAgentDeclaration {
  return 'kind' in agent && agent.kind === 'remote';
}

export function loadAgents(remote: RemoteAgentDeclaration[] = []): void {
  const loadedAgents = new Map<string, CatalogAgent>();

  for (const [name, module] of Object.entries(agentModules)) {
    const loadedAgent = validateAgent(module, `${name}.ts`);

    loadedAgents.set(loadedAgent.name, loadedAgent);
  }

  for (const declaration of remote) {
    if (loadedAgents.has(declaration.name)) {
      throw new Error(`remote agent "${declaration.name}" shadows a repository agent`);
    }

    loadedAgents.set(declaration.name, declaration);
  }

  agents = loadedAgents;

  console.log(`[agents] loaded: ${[...agents.keys()].join(', ') || '(none)'}`);
}

// The names of the repository's own agents — what an extension must not
// shadow (validateRemoteAgent); independent of the loaded catalog.
export function repositoryAgentNames(): Set<string> {
  return new Set(Object.keys(agentModules));
}

export function getAgent(name: string): CatalogAgent | null {
  return agents.get(name) ?? null;
}

export function getRemoteAgent(name: string): RemoteAgentDeclaration | null {
  const agent = agents.get(name);

  return agent && isRemoteAgent(agent) ? agent : null;
}

export function isRemoteAgentName(name: string): boolean {
  return getRemoteAgent(name) !== null;
}

// Sorted by name so serialized derivations (the coordinator's function
// definitions — part of the prompt-cache head) do not depend on load order.
export function getAgents(): CatalogAgent[] {
  return [...agents.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function getRemoteAgents(): RemoteAgentDeclaration[] {
  return getAgents().filter(isRemoteAgent);
}

// The server whose presence in a passport brings the remote kinds along —
// the mirror of the tool-bundle rule (src/capabilities/tool-manager.ts):
// a passport with the project registry is a working one, and the
// installation's remote agents come with it.
const REMOTE_GATE_SERVER = 'projects';

// Whether a declaration may spawn the named agent: its own `agents` list,
// or — for a remote kind — the passport's "projects".
export function mayAgentSpawn(declaration: Pick<AgentDeclaration, 'agents' | 'tools'>, name: string): boolean {
  return Boolean(declaration.agents?.includes(name)) || (declaration.tools.includes(REMOTE_GATE_SERVER) && isRemoteAgentName(name));
}

// The remote kinds a declaration may spawn (for its spawn_agent words).
export function spawnableRemoteAgents(declaration: Pick<AgentDeclaration, 'agents' | 'tools'>): RemoteAgentDeclaration[] {
  return declaration.tools.includes(REMOTE_GATE_SERVER) ? getRemoteAgents() : [];
}
