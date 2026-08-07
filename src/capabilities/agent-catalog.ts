// The dynamic agent catalog (§7.2): agents/*.ts loaded with native import()
// and an mtime cache-bust, validated hard on load. The core is a bundle and
// the agents are native modules — only data and types cross that boundary
// (§7.1), so a module is trusted only after validateAgent.

import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AgentDeclaration } from '../core/contract.ts';
import { validateAgent } from './validate-agent.ts';

const AGENTS_DIRECTORY = path.resolve('agents');
const AGENT_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

let agents = new Map<string, AgentDeclaration>();

async function importAgent(filepath: string): Promise<AgentDeclaration> {
  const fileStat = await stat(filepath);
  const moduleUrl = pathToFileURL(filepath);

  moduleUrl.searchParams.set('v', String(fileStat.mtimeMs));

  const module = (await import(moduleUrl.href)) as Record<string, unknown>;

  return validateAgent(module, path.basename(filepath));
}

export async function loadAgents(): Promise<void> {
  const entries = await readdir(AGENTS_DIRECTORY, { withFileTypes: true });
  const filenames = entries
    .filter(entry => entry.isFile() && entry.name.endsWith('.ts'))
    .map(entry => entry.name)
    .sort();

  const loadedAgents = new Map<string, AgentDeclaration>();

  for (const filename of filenames) {
    const loadedAgent = await importAgent(path.join(AGENTS_DIRECTORY, filename));

    if (loadedAgents.has(loadedAgent.name)) {
      throw new Error(`Duplicate agent name "${loadedAgent.name}"`);
    }

    loadedAgents.set(loadedAgent.name, loadedAgent);
  }

  agents = loadedAgents;

  console.log(`[agents] loaded from ${AGENTS_DIRECTORY}: ${[...agents.keys()].join(', ') || '(none)'}`);
}

// Hot-reload entry (stage 5 wires the capability.reload.* consumer to it).
export async function reloadAgent(agentName: string): Promise<AgentDeclaration> {
  if (!AGENT_NAME_PATTERN.test(agentName)) {
    throw new Error(`Agent name "${agentName}" must match ${AGENT_NAME_PATTERN}`);
  }

  const loadedAgent = await importAgent(path.join(AGENTS_DIRECTORY, `${agentName}.ts`));

  agents = new Map(agents).set(loadedAgent.name, loadedAgent);

  console.log(`[agents] reloaded: ${loadedAgent.name}`);

  return loadedAgent;
}

export function getAgent(name: string): AgentDeclaration | null {
  return agents.get(name) ?? null;
}

// Sorted by name so serialized derivations (the coordinator's function
// definitions — part of the prompt-cache head) do not depend on load order.
export function getAgents(): AgentDeclaration[] {
  return [...agents.values()].sort((a, b) => a.name.localeCompare(b.name));
}
