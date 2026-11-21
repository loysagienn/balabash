import { agentGrantPolicy, isRemoteAgent, startable } from '../capabilities/agent-catalog.ts';
import { computeGrant, describe, grantedChildren, grantedGuide, type ActionName, type CatalogNode, type ConnectionsPort, type DescribeValue, type Grant } from '../catalog/index.ts';
import type { AgentPassport } from '../core/contract.ts';
import { catalog } from '../tree/index.ts';
import { connectionsPort } from '../tree/services.ts';

export const portActions = ['describe', 'run_program'] as const;

export async function catalogContext(agent: AgentPassport, workspaceId: string, threadId: string, actions: readonly ActionName[] = portActions) {
  const connections = connectionsPort();
  const caller = { workspaceId, threadId, agentName: agent.name };
  const grant = await computeGrant(catalog(workspaceId), agentGrantPolicy(agent, actions), { caller, connections });
  return { grant, connections };
}

// Each showcase entry is a first opening, independent of its neighbours.
// The same port formatter handles live describe results; sampling never dispatches a call.
export async function* sampleOpenings<T>(grant: Grant, connections: ConnectionsPort, render: (opened: DescribeValue) => T) {
  for (const name of grant.vertices) {
    const opened = await describe(grant, name ? { name } : {}, { connections });
    yield { name, result: render(opened) };
  }
}

export function grantKey(grant: Grant): string {
  return JSON.stringify(Array.from(grant.vertices, name => {
    const vertex = grant.catalog.vertices.get(name);
    return vertex?.kind === 'node' && vertex.installation ? [name, vertex.installation.revision] : name;
  }));
}

export function* grantedCapabilities(grant: Grant) {
  for (const name of grant.vertices) {
    const vertex = grant.catalog.vertices.get(name)!;
    if (vertex.kind === 'capability') yield vertex;
  }
}

// Opening a leaf directly supplies its parent's guide once. Opening the
// parent itself already delivered that guide in the node description.
export function guideForLeaf(grant: Grant, parent: CatalogNode, seenNodes: Set<string>): string[] {
  if (seenNodes.has(parent.fullName)) return [];
  seenNodes.add(parent.fullName);
  return grantedGuide(grant, parent);
}

export function vertexLine(kind: string, name: string, summary: string): string {
  return `${kind} ${name} — ${summary}`;
}

export function catalogInstructions(grant: Grant, portRule: string): string {
  const root = grant.catalog.root;
  const agents = startable(grant.caller.agentName).map(agent =>
    JSON.stringify({
      name: agent.name,
      description: agent.description,
      modes: agent.modes,
      defaultMode: agent.defaultMode,
      ...(isRemoteAgent(agent) ? { remote: true, options: agent.options ?? {} } : {}),
    }),
  );
  return [
    'Catalog guide',
    ...grantedGuide(grant, root),
    '\nCatalog entries',
    ...grantedChildren(grant, root).map(child => vertexLine(child.kind, child.fullName, child.summary)),
    '\n' + portRule,
    ...(grant.vertices.has('spawn_agent') && agents.length ? ['\nAgents you can start:', ...agents] : []),
  ].join('\n');
}
