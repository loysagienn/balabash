// One grant per codex exec invocation. The stateless HTTP transport creates
// a protocol Server per request, all reading the same turn's port.
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { expandSchema, grantedGuide, grantedVertex, type JsonSchema, type JsonValue } from '../../catalog/index.ts';
import type { AgentPassport } from '../../core/contract.ts';
import { dispatchCatalogCall } from '../../tree/call-journal.ts';
import { catalogContext, catalogInstructions, portActions } from '../catalog-context.ts';
import { BRIDGE_SERVER } from './session-config.ts';

const RULE =
  'In exec, open a catalog entry with tools.mcp__balabash__describe({name}) and read its structuredContent. ' +
  'Call capabilities as tools.mcp__balabash__<name>(input). Read structuredContent.value on success and content on error. ' +
  'Use JavaScript in exec for calls in this turn. To run platform program code that can also run as a task, use tools.mcp__balabash__run_program({code}).';

export async function createCodexPort(agent: AgentPassport, workspaceId: string, threadId: string) {
  const { grant, connections } = await catalogContext(agent, workspaceId, threadId);
  const tree = grant.catalog;
  const tools: Tool[] = [];
  function add(name: string, description: string, input: JsonSchema, output: JsonSchema) {
    // MCP requires object roots for both schemas. A uniform envelope also
    // carries scalar, array and null results without changing their types.
    const properties: Record<string, JsonSchema> = { value: expandSchema(tree, output) };
    if (name === 'describe') properties.guide = { type: 'array', items: { type: 'string' } };
    tools.push({
      name, description, inputSchema: { ...expandSchema(tree, input), type: 'object' },
      outputSchema: { type: 'object', properties, required: ['value'], additionalProperties: false },
    });
  }
  for (const name of portActions) {
    const action = tree.actions.get(name)!;
    add(name, action.description, action.input, action.output);
  }
  for (const name of grant.vertices) {
    const vertex = tree.vertices.get(name)!;
    if (vertex.kind === 'capability') add(name, vertex.description, vertex.input, vertex.output);
  }

  const seenNodes = new Set(['']);
  async function call(name: string, input: JsonValue): Promise<CallToolResult> {
    const result = await dispatchCatalogCall(grant, connections, { name, input, callId: randomUUID() });
    if ('error' in result) return { isError: true, content: [{ type: 'text', text: JSON.stringify(result.error) }] };
    let guide: string[] | undefined;
    if (result.opened?.kind === 'node') seenNodes.add(result.opened.name);
    if (result.opened?.kind === 'capability') {
      const vertex = grantedVertex(grant, result.opened.name);
      if (vertex?.kind === 'capability' && !seenNodes.has(vertex.parent.fullName)) {
        guide = grantedGuide(grant, vertex.parent);
        seenNodes.add(vertex.parent.fullName);
      }
    }
    return { content: [], structuredContent: { ...(guide?.length ? { guide } : {}), value: result.value } };
  }

  return {
    instructions: catalogInstructions(grant, RULE),
    tools,
    createServer() {
      const server = new Server({ name: BRIDGE_SERVER, version: '2.0.0' }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
      server.setRequestHandler(CallToolRequestSchema, request => call(request.params.name, (request.params.arguments ?? {}) as JsonValue));
      return server;
    },
  };
}
