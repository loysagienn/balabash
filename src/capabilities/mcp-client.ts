// A call of a tool of an external MCP server: what a node of an external
// server stands on. MCP is the wire here and nothing more — the capability
// keeps its own name, its own input type and its own output type; its node
// turns the answer of the server into the value.
//
// Each call is a connection of its own: opened, used once, closed. Nothing
// is kept between calls, so the authority of a call is the one the platform
// gave it — secrets entered a moment ago are the ones that go out.

import type { ExternalServerConfig } from './server-config.ts';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ErrorCode, McpError, ListToolsResultSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { CapabilityError, type JsonObject } from '../catalog/index.ts';

const CLIENT_INFO = { name: 'balabash', version: '2.0.0' };

// The longest a server may take to answer one call.
export const EXTERNAL_CALL_TIMEOUT_MS = 10 * 60_000;
const CONNECT_TIMEOUT_MS = 30_000;

export type ExternalServer = {
  // How the server is called in the text of an error.
  title: string;
  url: string;
  // The headers that carry the authority of the call.
  headers?: Record<string, string>;
  fetch?: FetchLike;
};

// What a tool answered: its text blocks joined, and its structured content
// when the server gave one.
export type ToolAnswer = {
  text: string;
  structured: Record<string, unknown> | null;
};

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// The server did not take the credentials of the call (HTTP 401). What that
// means is the node's to say: it knows whose credentials went out — a secret
// of the installation the operator has to enter again, a token of an account
// that can be renewed and tried once more. A node that says nothing leaves
// the call with this error: the outside system refused.
export class CredentialsRefusedError extends CapabilityError {
  constructor(server: ExternalServer, detail: string) {
    super('external_error', `${server.title} refused the credentials of the call (HTTP 401): ${detail}`);
  }
}

// Who fixes a failed exchange: a server that answered with a refusal — the
// server (its refusal of the credentials is told apart, see above); no
// answer at all — nobody knows the outcome.
function failure(server: ExternalServer, error: unknown, signal: AbortSignal | null): CapabilityError {
  if (signal?.aborted) {
    return new CapabilityError('unavailable', `The call to ${server.title} was cancelled before it answered.`);
  }

  if (error instanceof StreamableHTTPError && error.code === 401) {
    return new CredentialsRefusedError(server, error.message);
  }

  if (error instanceof StreamableHTTPError && typeof error.code === 'number' && error.code >= 400) {
    return new CapabilityError('external_error', `${server.title} refused the request (HTTP ${error.code}): ${error.message}`);
  }

  if (error instanceof McpError) {
    return error.code === ErrorCode.RequestTimeout || error.code === ErrorCode.ConnectionClosed
      ? new CapabilityError('unavailable', `${server.title} did not answer: ${error.message}`)
      : new CapabilityError('external_error', `${server.title} refused the request: ${error.message}`);
  }

  return new CapabilityError('unavailable', `${server.title} did not answer: ${reason(error)}`);
}

function textOf(content: unknown): string {
  const blocks = Array.isArray(content) ? content : [];

  return blocks
    .flatMap(block =>
      block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string' ? [block.text] : [],
    )
    .join('\n');
}

async function withServer<T>(
  server: ExternalServer,
  options: { signal: AbortSignal | null; timeoutMs?: number },
  exchange: (client: Client, signal: AbortSignal | undefined, timeout: number) => Promise<T>,
): Promise<T> {
  const timeout = options.timeoutMs ?? EXTERNAL_CALL_TIMEOUT_MS;
  const signal = options.signal ?? undefined;
  const client = new Client(CLIENT_INFO);
  // Client.connect's timeout covers initialize, but the SDK then sends an
  // initialized notification without request options. Bound its HTTP POST too.
  const connectTime = Math.min(timeout, CONNECT_TIMEOUT_MS);
  const handshake = AbortSignal.timeout(connectTime);
  let connecting = true;
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: { headers: server.headers },
    fetch: (url, init) => {
      const signals: AbortSignal[] = [];
      // DELETE has no timeout option in the SDK. Give cleanup its own budget,
      // including when the caller has cancelled the original request.
      if (init?.method === 'DELETE') signals.push(AbortSignal.timeout(5_000));
      else {
        if (init?.signal) signals.push(init.signal);
        if (signal) signals.push(signal);
        if (connecting && init?.method === 'POST') signals.push(handshake);
      }
      return (server.fetch ?? fetch)(url, { ...init, signal: AbortSignal.any(signals) });
    },
  });

  try {
    await client.connect(transport, { signal, timeout: connectTime });
    connecting = false;

    return await exchange(client, signal, timeout);
  } catch (error) {
    throw error instanceof CapabilityError ? error : failure(server, error, options.signal);
  } finally {
    // A failed DELETE cannot change the outcome of a completed write or
    // trigger an auth retry. Stateless transports have no session to delete.
    await transport.terminateSession().catch(error => {
      console.warn(`[mcp] could not end the session at ${server.title}: ${reason(error)}`);
    });
    await client.close().catch(() => {});
  }
}

export function listServerTools(server: ExternalServer): Promise<Tool[]> {
  return withServer(server, { signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS), timeoutMs: CONNECT_TIMEOUT_MS }, async (client, signal, timeout) => {
    const tools: Tool[] = [];
    let cursor: string | undefined;
    do {
      // The catalog compiles validators once for all pages. Client.listTools
      // would compile them again into this short-lived discovery session.
      const page = await client.request({ method: 'tools/list', params: { cursor } }, ListToolsResultSchema, { signal, timeout });
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  });
}

export function callServerResult(
  server: ExternalServer, tool: string, args: JsonObject, options: { signal: AbortSignal | null; timeoutMs?: number },
): Promise<CallToolResult> {
  return withServer(server, options, async (client, signal, timeout) => {
    const result = await client.callTool({ name: tool, arguments: args }, undefined, {
      signal, timeout, resetTimeoutOnProgress: true, maxTotalTimeout: timeout,
    }) as CallToolResult;
    if (result.isError) {
      throw new CapabilityError('external_error', `${server.title} refused the request: ${textOf(result.content) || '(no message)'}`);
    }
    return result;
  });
}

export async function callServerTool(
  server: ExternalServer, tool: string, args: JsonObject, options: { signal: AbortSignal | null; timeoutMs?: number },
): Promise<ToolAnswer> {
  const result = await callServerResult(server, tool, args, options);
  return { text: textOf(result.content), structured: result.structuredContent ?? null };
}

// Connections only needs the first page for a credential-backed service
// without a catalog node. The HTTP probe shares the catalog session lifecycle.
export async function probeExternalService(
  name: string, config: Exclude<ExternalServerConfig, { transport: 'claude-connector' }>,
): Promise<void> {
  if (config.transport === 'http') {
    await withServer({ title: name, url: config.url, headers: config.headers },
      { signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS), timeoutMs: CONNECT_TIMEOUT_MS },
      (client, signal, timeout) => client.listTools({}, { signal, timeout }));
    return;
  }
  const client = new Client(CLIENT_INFO);
  const transport = new StdioClientTransport({
    command: config.command, args: config.args ?? [],
    env: config.env ? { ...(process.env as Record<string, string>), ...config.env } : undefined,
  });
  try {
    await client.connect(transport);
    await client.listTools();
  } finally {
    await client.close();
  }
}
