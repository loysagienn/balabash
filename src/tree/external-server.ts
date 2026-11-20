// A call of a tool of an external MCP server: what a node of an external
// server stands on. MCP is the wire here and nothing more — the capability
// keeps its own name, its own input type and its own output type; its node
// turns the answer of the server into the value.
//
// Each call is a connection of its own: opened, used once, closed. Nothing
// is kept between calls, so the authority of a call is the one the platform
// gave it — secrets entered a moment ago are the ones that go out.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
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
  headers: Record<string, string>;
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

export async function callServerTool(
  server: ExternalServer,
  tool: string,
  args: JsonObject,
  options: { signal: AbortSignal | null; timeoutMs?: number },
): Promise<ToolAnswer> {
  const signal = options.signal ?? undefined;
  const timeout = options.timeoutMs ?? EXTERNAL_CALL_TIMEOUT_MS;
  const client = new Client(CLIENT_INFO);
  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: { headers: server.headers },
  });

  try {
    await client.connect(transport, { signal, timeout: Math.min(timeout, CONNECT_TIMEOUT_MS) });

    const result = await client.callTool({ name: tool, arguments: args }, undefined, {
      signal,
      timeout,
      resetTimeoutOnProgress: true,
      maxTotalTimeout: timeout,
    });
    const text = textOf(result.content);

    if (result.isError) {
      throw new CapabilityError('external_error', `${server.title} refused the request: ${text || '(no message)'}`);
    }

    const structured = result.structuredContent;

    return {
      text,
      structured:
        structured && typeof structured === 'object' && !Array.isArray(structured)
          ? (structured as Record<string, unknown>)
          : null,
    };
  } catch (error) {
    throw error instanceof CapabilityError ? error : failure(server, error, options.signal);
  } finally {
    await client.close().catch(() => {});
  }
}
