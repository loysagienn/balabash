// MCP client connections for tool servers (§10): stdio | http transports,
// per-user OAuth transports for servers with auth: "user", and
// claude-connector transports that reuse claude.ai account-level connectors
// through Anthropic's MCP proxy on the operator's ambient CLI login.

import crypto from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import { resolveOperatorCredentials } from '../adapters/ccr/token.ts';
import { createTransportAuthProvider } from './connections/oauth-provider.ts';
import type { EnabledTools, ExternalServerConfig, ToolOverride } from './server-config.ts';
import type { UserAuthServer } from './tool-manager.ts';

const CLIENT_INFO = { name: 'balabash', version: '2.0.0' };

// Anthropic's MCP proxy for claude.ai connectors: the upstream OAuth tokens
// (Slack etc.) live on claude.ai; the proxy authenticates by the operator's
// claude.ai access token. Undocumented alpha, mirrored from the Claude Code
// CLI (MCP_PROXY_URL / MCP_PROXY_PATH in its build constants).
const CLAUDE_CONNECTOR_PROXY_BASE = 'https://mcp-proxy.anthropic.com/v1/mcp/';
const CLAUDE_CONNECTOR_BETA_HEADER = 'mcp-servers-2025-12-04';

// The ambient token rotates on disk (~8h); read it fresh on every request so
// a long-lived connection survives rotation. The client session id is the
// proxy's required correlation header — one per transport lifetime.
function createClaudeConnectorFetch(): FetchLike {
  const clientSessionId = crypto.randomUUID();

  return async (url, init) => {
    const credentials = await resolveOperatorCredentials();
    const headers = new Headers(init?.headers);

    headers.set('Authorization', `Bearer ${credentials.accessToken}`);
    headers.set('X-Mcp-Client-Session-Id', clientSessionId);
    headers.set('anthropic-beta', CLAUDE_CONNECTOR_BETA_HEADER);

    return fetch(url, { ...init, headers });
  };
}

export type ToolFunction = {
  // Function name exposed to the model: the MCP tool name, prefixed with
  // "<server>__" when the server's config sets prefixTools (one flat
  // function namespace across servers).
  functionName: string;
  serverName: string;
  toolName: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type ConnectedServer = {
  name: string;
  origin: 'file' | 'external';
  // Connection row id and account slug backing this client — present on
  // user-auth servers only.
  connectionId?: string;
  accountKey?: string;
  client: Client;
  close: () => Promise<void>;
  functions: ToolFunction[];
  // Opens a fresh connection (new transport, new MCP session) with the same
  // configuration. Only streamable-http servers have one: their sessions can
  // die under a live client — see isLostSessionError.
  reconnect?: () => Promise<ConnectedServer>;
};

// A stateful streamable-http server keeps its sessions in process memory: a
// redeploy or a pod restart forgets every Mcp-Session-Id it ever issued, and
// per the spec it then answers 404 to the old id (the python SDK's body reads
// "Session not found" / "Session has been terminated"); a request without a
// session id draws 400 "Missing session ID". The SDK client neither drops the
// stale id nor re-initializes — the caller has to reconnect.
export function isLostSessionError(error: unknown): boolean {
  if (!(error instanceof StreamableHTTPError)) {
    return false;
  }

  return error.code === 404 || (error.code === 400 && /session/i.test(error.message));
}

// What the config says about the server's tool catalog: the positive
// selection (enabledTools), the per-tool adjustments (toolOverrides) and
// the namespace remap (prefixTools).
export type ToolSelection = {
  enabledTools?: EnabledTools;
  toolOverrides?: Record<string, ToolOverride>;
  prefixTools?: boolean;
};

async function listServerFunctions(
  serverName: string,
  client: Client,
  { enabledTools, toolOverrides, prefixTools }: ToolSelection = {},
): Promise<ToolFunction[]> {
  const { tools } = await client.listTools();

  if (enabledTools) {
    const advertised = new Set(tools.map(tool => tool.name));
    const missing = enabledTools.filter(name => !advertised.has(name));

    // The server renamed or dropped a tool the config counts on: visible in
    // the log, not fatal — the rest of the selection still works.
    if (missing.length) {
      console.warn(`[tools] "${serverName}" does not advertise enabled tools: ${missing.join(', ')}`);
    }
  }

  // With prefixTools the server attribution moves into the function name
  // (and is repeated in the description: a bare server-side name like "ask"
  // says nothing about which integration it belongs to); the calls back to
  // the server still use the unprefixed toolName.
  return tools
    .filter(tool => !enabledTools || enabledTools.includes(tool.name))
    .filter(tool => !toolOverrides?.[tool.name]?.disabled)
    .map(tool => ({
      functionName: prefixTools ? `${serverName}__${tool.name}` : tool.name,
      serverName,
      toolName: tool.name,
      description: `${prefixTools ? `[${serverName}] ` : ''}${toolOverrides?.[tool.name]?.description ?? tool.description ?? tool.name}`,
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
      : config.transport === 'claude-connector'
        ? new StreamableHTTPClientTransport(new URL(config.serverId, CLAUDE_CONNECTOR_PROXY_BASE), {
            fetch: createClaudeConnectorFetch(),
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
    functions: await listServerFunctions(serverName, client, config),
    ...(config.transport === 'stdio' ? {} : { reconnect: () => connectExternalServer(serverName, config) }),
  };
}

// Connects one account of an auth: "user" server, addressed by its connection
// row: the transport auth provider serves that row's stored tokens and
// refreshes them; an UnauthorizedError here means the user must re-authorize.
export async function connectUserServer(
  server: UserAuthServer,
  connection: { id: string; server: string; accountKey: string },
): Promise<ConnectedServer> {
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    authProvider: createTransportAuthProvider(connection, server.url),
  });
  const client = new Client(CLIENT_INFO);

  await client.connect(transport);

  return {
    name: server.name,
    origin: server.origin,
    connectionId: connection.id,
    accountKey: connection.accountKey,
    client,
    close: () => client.close(),
    functions: await listServerFunctions(server.name, client, server),
    reconnect: () => connectUserServer(server, connection),
  };
}
