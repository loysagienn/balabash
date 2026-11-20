// The SDK takes a McpServer instance. Install the catalog handlers on its
// protocol server so a schema refusal follows the same journaled path as a call.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { grantedGuide, grantedVertex, ruleText, typeText, type JsonValue } from '../../catalog/index.ts';
import type { AgentPassport, JsonObject, SessionEnvironmentTool } from '../../core/contract.ts';
import { catalogInstructions, grantKey } from '../catalog-context.ts';
import { mcpCatalog, mcpError, registerCatalogHandlers } from '../catalog-mcp.ts';
import { BRIDGE_SERVER } from '../sdk-mcp-config.ts';

const RULE = 'Use mcp__balabash__describe to open a catalog entry. Call the opened capability as mcp__balabash__<name>. ' +
  'If describe returns its definition as text, load the function with ToolSearch using select:mcp__balabash__<name>. ' +
  'After context compaction, describe a capability again before calling it.';

export async function createClaudePort(agent: AgentPassport, workspaceId: string, threadId: string) {
  const catalog = await mcpCatalog(agent, workspaceId, threadId);
  const { grant } = catalog;
  const tools: Tool[] = catalog.entries.map(({ tool, action }) =>
    action ? { ...tool, _meta: { 'anthropic/alwaysLoad': true } } : tool);
  return {
    tools,
    grantKey: grantKey(grant),
    instructions: catalogInstructions(grant, RULE),
    async call(name: string, input: JsonValue) {
      const answer = await catalog.call(name, input);
      if ('error' in answer) {
        return mcpError(answer.error);
      }
      const { opened } = answer;
      let value = answer.value;
      if (opened?.kind === 'capability') {
        const leaf = grantedVertex(grant, opened.name);
        if (leaf?.kind !== 'capability') throw new Error('Missing described capability');
        // Text doubles as the usable result if the CLI skips the mod. A
        // successful hook replaces it with a reference and just the companion.
        value = {
          ...opened, parent: leaf.parent.fullName, guide: leaf.parent.fullName ? grantedGuide(grant, leaf.parent) : [],
          returns: typeText(leaf.output, 0), rules: leaf.inputRules.map(ruleText),
        };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
    },
  };
}

export async function createClaudeBridge(agent: AgentPassport, workspaceId: string, threadId: string) {
  let port = await createClaudePort(agent, workspaceId, threadId);
  // Only the initial catalog survives compaction in the system prompt.
  const systemPort = port;
  let contextPort = systemPort;
  let listChanged = false;
  const server = new McpServer({ name: BRIDGE_SERVER, version: '2.0.0' }, { capabilities: { tools: { listChanged: true } } });
  registerCatalogHandlers(server.server, () => port);
  return {
    server, instructions: systemPort.instructions,
    onCompact() {
      contextPort = systemPort;
    },
    async refresh(text: string) {
      try {
        const next = await createClaudePort(agent, workspaceId, threadId);
        if (next.grantKey !== port.grantKey) listChanged = true;
        port = next;
        if (listChanged) {
          await server.server.sendToolListChanged();
          listChanged = false;
        }
      } catch (error) {
        console.error(`[claude-catalog:${threadId}] refresh failed:`, error);
      }
      if (contextPort.grantKey === port.grantKey && contextPort.instructions === port.instructions) return text;
      contextPort = port;
      return `[Updated Balabash catalog — replaces the catalog section of your instructions]\n${port.instructions}\n\n${text}`;
    },
  };
}

// Environment tools have their own namespace. The CLI can discover them
// normally and the session journal records them alongside native tools.
export function environmentServer(tools: SessionEnvironmentTool[]) {
  const server = new McpServer({ name: 'environment', version: '1.0.0' });
  for (const tool of tools) {
    server.registerTool(tool.name, { description: tool.description, inputSchema: z.fromJSONSchema(tool.inputSchema as never) },
      async args => {
        const value = await tool.handler(args as JsonObject);
        return { content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value) }] };
      });
  }
  return server;
}
