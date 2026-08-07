// MCP client connections for tool servers (§10): stdio | http transports.
// Per-user OAuth transports (auth: "user") join at the connections step of
// stage 4 through connectUserServer.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ExternalServerConfig } from './server-config.ts';

const CLIENT_INFO = { name: 'balabash', version: '2.0.0' };

export type ToolFunction = {
  // Function name exposed to the model; currently equals the MCP tool name.
  functionName: string;
  serverName: string;
  toolName: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type ConnectedServer = {
  name: string;
  origin: 'file' | 'external';
  client: Client;
  close: () => Promise<void>;
  functions: ToolFunction[];
};

async function listServerFunctions(serverName: string, client: Client): Promise<ToolFunction[]> {
  const { tools } = await client.listTools();

  return tools.map(tool => ({
    functionName: tool.name,
    serverName,
    toolName: tool.name,
    description: tool.description ?? tool.name,
    inputSchema: (tool.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
  }));
}

export async function connectExternalServer(
  serverName: string,
  config: ExternalServerConfig,
): Promise<ConnectedServer> {
  const transport =
    config.transport === 'stdio'
      ? new StdioClientTransport({
          command: config.command,
          args: config.args ?? [],
          env: config.env ? { ...(process.env as Record<string, string>), ...config.env } : undefined,
        })
      : new StreamableHTTPClientTransport(new URL(config.url), {
          requestInit: config.headers ? { headers: config.headers } : undefined,
        });

  const client = new Client(CLIENT_INFO);

  await client.connect(transport);

  return {
    name: serverName,
    origin: 'external',
    client,
    close: () => client.close(),
    functions: await listServerFunctions(serverName, client),
  };
}
