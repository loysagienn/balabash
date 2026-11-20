// One grant per codex exec invocation. The stateless HTTP transport creates
// a protocol Server per request, all reading the same turn's port.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { portSchema, grantedVertex, type DescribeValue, type JsonSchema, type JsonValue } from '../../catalog/index.ts';
import type { AgentPassport } from '../../core/contract.ts';
import { mcpCatalog, mcpError, registerCatalogHandlers } from '../catalog-mcp.ts';
import { BRIDGE_SERVER } from '../sdk-mcp-config.ts';
import { catalogInstructions, guideForLeaf, sampleOpenings } from '../catalog-context.ts';

const RULE =
  'In exec, open a catalog entry with tools.mcp__balabash__describe({name}). Use the same prefix for each catalog function. ' +
  'Read structuredContent.value and any structuredContent.guide on success, and content on error. ' +
  'Chain calls for the current turn in exec. To test code for a scheduled task, pass its body to run_program({code}). ' +
  'Inside that program, invoke capabilities with call(name, input).';

// MCP requires an object result. Local references in a server output schema
// move with it under structuredContent.value (an explicit $id owns its base).
function underValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(underValue);
  if (!value || typeof value !== 'object' || '$id' in value) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key, key === '$ref' && typeof item === 'string' && (item === '#' || item.startsWith('#/'))
      ? '#/properties/value' + item.slice(1) : underValue(item),
  ]));
}

export async function createCodexPort(agent: AgentPassport, workspaceId: string, threadId: string) {
  const catalog = await mcpCatalog(agent, workspaceId, threadId);
  const { grant } = catalog;
  const tools: Tool[] = catalog.entries.map(({ tool, entry }) => {
    const output = portSchema(grant.catalog, entry, 'output');
    const properties: Record<string, JsonSchema> = { value: underValue(output) as JsonSchema };
    if (tool.name === 'describe') properties.guide = { type: 'array', items: { type: 'string' } };
    return { ...tool, outputSchema: { type: 'object', properties, required: ['value'], additionalProperties: false } };
  });

  function openingValue(opened: DescribeValue, seenNodes: Set<string>) {
    if (opened.kind === 'node') {
      seenNodes.add(opened.name);
      return { value: opened };
    }
    const vertex = grantedVertex(grant, opened.name);
    if (vertex?.kind !== 'capability') throw new Error('Missing described capability');
    const guide = guideForLeaf(grant, vertex.parent, seenNodes);
    return { ...(guide.length ? { guide } : {}), value: opened };
  }

  const seenNodes = new Set(['']);
  async function call(name: string, input: JsonValue): Promise<CallToolResult> {
    const result = await catalog.call(name, input);
    if ('error' in result) return mcpError(result.error);
    const structuredContent = result.opened ? openingValue(result.opened, seenNodes) : { value: result.value };
    return { content: [], structuredContent };
  }

  return {
    instructions: catalogInstructions(grant, RULE),
    tools,
    sampleOpenings: () => sampleOpenings(grant, catalog.connections, opened => openingValue(opened, new Set(['']))),
    createServer() {
      const server = new Server({ name: BRIDGE_SERVER, version: '2.0.0' }, { capabilities: { tools: {} } });
      registerCatalogHandlers(server, () => ({ tools, call }));
      return server;
    },
  };
}
