// The agent catalog (§7.2): agents ship inside the app bundle through the
// static index — the import() machinery went away with hot-reload (the only
// reload is an app restart). Modules are still validated hard at boot: a
// broken declaration fails the start, and the supervisor rolls back to the
// last good bundle — failures are atomic instead of half-loaded.

import type { AgentDeclaration } from '../core/contract.ts';
import { agentModules } from '../../agents/index.ts';
import { validateAgent } from './validate-agent.ts';

let agents = new Map<string, AgentDeclaration>();

export function loadAgents(): void {
  const loadedAgents = new Map<string, AgentDeclaration>();

  for (const [name, module] of Object.entries(agentModules)) {
    const loadedAgent = validateAgent(module, `${name}.ts`);

    loadedAgents.set(loadedAgent.name, loadedAgent);
  }

  agents = loadedAgents;

  console.log(`[agents] loaded: ${[...agents.keys()].join(', ') || '(none)'}`);
}

export function getAgent(name: string): AgentDeclaration | null {
  return agents.get(name) ?? null;
}

// Sorted by name so serialized derivations (the coordinator's function
// definitions — part of the prompt-cache head) do not depend on load order.
export function getAgents(): AgentDeclaration[] {
  return [...agents.values()].sort((a, b) => a.name.localeCompare(b.name));
}
