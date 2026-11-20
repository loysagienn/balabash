// Both SDK transports register these handlers on the protocol Server. The
// catalog validates arguments inside dispatch, after the start is journaled.
import { randomUUID } from 'node:crypto';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { portSchema, type CapabilityErrorValue, type JsonValue } from '../catalog/index.ts';
import type { AgentPassport } from '../core/contract.ts';
import { dispatchCatalogCall } from '../tree/call-journal.ts';
import { catalogContext, grantedCapabilities, portActions } from './catalog-context.ts';

export async function mcpCatalog(agent: AgentPassport, workspaceId: string, threadId: string) {
  const { grant, connections } = await catalogContext(agent, workspaceId, threadId);
  const tree = grant.catalog;
  const entries = [
    ...portActions.map(name => ({ name, entry: tree.actions.get(name)!, action: true })),
    ...Array.from(grantedCapabilities(grant), entry => ({ name: entry.fullName, entry, action: false })),
  ].map(({ name, entry, action }) => ({
    tool: { name, description: entry.description, inputSchema: { ...portSchema(tree, entry, 'input'), type: 'object' as const } },
    entry, action,
  }));
  return {
    grant, entries,
    call: (name: string, input: JsonValue) => dispatchCatalogCall(grant, connections, { name, input, callId: randomUUID() }),
  };
}

export function mcpError(error: CapabilityErrorValue): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(error) }] };
}

export function registerCatalogHandlers(server: Server, current: () => {
  tools: Tool[];
  call(name: string, input: JsonValue): Promise<CallToolResult>;
}) {
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: current().tools }));
  server.setRequestHandler(CallToolRequestSchema, ({ params }) => current().call(params.name, (params.arguments ?? {}) as JsonValue));
}
