// One grant per codex exec invocation. The stateless HTTP transport creates
// a protocol Server per request, all reading the same turn's port.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { expandSchema, grantedVertex, type JsonSchema, type JsonValue } from '../../catalog/index.ts';
import type { AgentPassport } from '../../core/contract.ts';
import { mcpCatalog, registerCatalogHandlers } from '../catalog-mcp.ts';
import { BRIDGE_SERVER } from '../sdk-mcp-config.ts';
import { catalogInstructions, guideForLeaf } from '../catalog-context.ts';

const RULE =
  'In exec, open a catalog entry with tools.mcp__balabash__describe({name}). Use the same prefix for each catalog function. ' +
  'Read structuredContent.value and any structuredContent.guide on success, and content on error. ' +
  'Chain calls for the current turn in exec. To test code for a scheduled task, pass its body to run_program({code}). ' +
  'Inside that program, invoke capabilities with call(name, input).';

export async function createCodexPort(agent: AgentPassport, workspaceId: string, threadId: string) {
  const catalog = await mcpCatalog(agent, workspaceId, threadId);
  const { grant } = catalog;
  const tools: Tool[] = catalog.entries.map(({ tool, output }) => {
    const properties: Record<string, JsonSchema> = { value: expandSchema(grant.catalog, output) };
    if (tool.name === 'describe') properties.guide = { type: 'array', items: { type: 'string' } };
    return { ...tool, outputSchema: { type: 'object', properties, required: ['value'], additionalProperties: false } };
  });

  const seenNodes = new Set(['']);
  async function call(name: string, input: JsonValue): Promise<CallToolResult> {
    const result = await catalog.call(name, input);
    if ('error' in result) return { isError: true, content: [{ type: 'text', text: JSON.stringify(result.error) }] };
    let guide: string[] | undefined;
    if (result.opened?.kind === 'node') seenNodes.add(result.opened.name);
    if (result.opened?.kind === 'capability') {
      const vertex = grantedVertex(grant, result.opened.name);
      if (vertex?.kind === 'capability') guide = guideForLeaf(grant, vertex.parent, seenNodes);
    }
    return { content: [], structuredContent: { ...(guide?.length ? { guide } : {}), value: result.value } };
  }

  return {
    instructions: catalogInstructions(grant, RULE),
    tools,
    createServer() {
      const server = new Server({ name: BRIDGE_SERVER, version: '2.0.0' }, { capabilities: { tools: {} } });
      registerCatalogHandlers(server, () => ({ tools, call }));
      return server;
    },
  };
}
