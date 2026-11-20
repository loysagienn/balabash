import { agentGrantPolicy, isRemoteAgent, startable } from '../capabilities/agent-catalog.ts';
import { computeGrant, grantedChildren, grantedGuide, type Grant } from '../catalog/index.ts';
import type { AgentPassport } from '../core/contract.ts';
import { catalog } from '../tree/index.ts';
import { connectionsPort } from '../tree/services.ts';

export const portActions = ['describe', 'run_program'] as const;

export async function catalogContext(agent: AgentPassport, workspaceId: string, threadId: string) {
  const connections = connectionsPort();
  const caller = { workspaceId, threadId, agentName: agent.name };
  const grant = await computeGrant(catalog(), agentGrantPolicy(agent, portActions), { caller, connections });
  return { grant, connections };
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
