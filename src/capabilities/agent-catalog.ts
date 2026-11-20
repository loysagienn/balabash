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

import type { AgentDeclaration, AgentPassport, RemoteAgentDeclaration } from '../core/contract.ts';
import { accessProfiles, coordinator } from '../../agents/access.ts';
import type { GrantPolicy } from '../catalog/grant.ts';
import { CapabilityError } from '../catalog/errors.ts';
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
  const repository = new Map<string, AgentDeclaration>();

  for (const [name, module] of Object.entries(agentModules)) {
    const loadedAgent = validateAgent(module, `${name}.ts`);

    repository.set(loadedAgent.name, loadedAgent);
  }

  for (const passport of [coordinator, ...repository.values()]) {
    for (const name of passport.agents ?? []) {
      if (!repository.has(name)) {
        throw new Error(`"${passport.name}" names unknown repository agent "${name}"`);
      }
    }
  }

  const loadedAgents = new Map<string, CatalogAgent>(repository);
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

// Sorted by name so serialized derivations (the coordinator's function
// definitions — part of the prompt-cache head) do not depend on load order.
export function getAgents(): CatalogAgent[] {
  return [...agents.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// Both the list shown to the model and the spawn action use this set.
export function startable(caller: string): CatalogAgent[] {
  const passport = caller === coordinator.name ? coordinator : getAgent(caller);
  if (!passport) {
    return [];
  }

  const local = 'access' in passport ? passport : null;

  return getAgents().filter(agent => {
    if (!isRemoteAgent(agent)) {
      return local?.agents?.includes(agent.name);
    }

    return agent.recipients?.some(name => name === caller || name === local?.access.profile);
  });
}

// A scheduled task and a child prefer a headless child. The secretary on
// its own turn (including a program run in place) uses the agent's default.
export function spawnHeadless(agent: CatalogAgent, preferHeadless: boolean, requested?: boolean): boolean {
  const defaultHeadless = agent.defaultMode === 'headless';
  const headless = requested ?? (defaultHeadless || (preferHeadless && agent.modes.includes('headless')));

  if (!agent.modes.includes(headless ? 'headless' : 'user')) {
    throw new CapabilityError(
      'invalid_input',
      `"${agent.name}" runs only ${defaultHeadless ? 'headless: it talks to its operator' : 'in a thread that talks to the user'}. Pass headless: ${defaultHeadless} or leave the field out.`,
    );
  }

  return headless;
}

// The port supplies its actions. The catalog still applies the workspace's
// connections and cuts each ungranted node together with all descendants.
export function agentGrantPolicy(agent: AgentPassport | RemoteAgentDeclaration, actions: GrantPolicy['actions']): GrantPolicy {
  const access = 'access' in agent ? agent.access : {};
  const profile = access.profile ? accessProfiles[access.profile] : undefined;
  const nodes = new Set([...(profile?.nodes ?? []), ...(access.nodes ?? [])]);
  const root = new Set(['send_message', 'end_thread']);

  if ('kind' in agent) {
    root.add('get_file_url');
  } else if (agent.workspaceDisk || agent.name === coordinator.name) {
    root.add('export_file');
    root.add('import_file');
  }
  if (agent.name === coordinator.name) {
    root.add('view_file');
  }

  if (startable(agent.name).length) {
    for (const verb of ['spawn_agent', 'send_to_thread', 'finish_thread', 'cancel_thread']) {
      root.add(verb);
    }
  }

  for (const grant of [profile, access]) {
    for (const name of grant?.addRoot ?? []) {
      root.add(name);
    }
    for (const name of grant?.removeRoot ?? []) {
      root.delete(name);
    }
  }

  return { actions, allows: vertex => (vertex.kind === 'node' ? nodes : root).has(vertex.fullName) };
}
