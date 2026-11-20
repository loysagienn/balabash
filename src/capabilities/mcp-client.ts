// MCP handshake and tool-list probe for installation service status.

import crypto from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import { resolveOperatorCredentials, tokenTtlMs, type OperatorCredentials } from '../adapters/ccr/token.ts';
import type { ExternalServerConfig } from './server-config.ts';

const CLIENT_INFO = { name: 'balabash', version: '2.0.0' };

// Anthropic's MCP proxy for claude.ai connectors: the upstream OAuth tokens
// (Slack etc.) live on claude.ai; the proxy authenticates by the operator's
// claude.ai access token. Undocumented alpha, mirrored from the Claude Code
// CLI (MCP_PROXY_URL / MCP_PROXY_PATH in its build constants).
const CLAUDE_CONNECTOR_PROXY_BASE = 'https://mcp-proxy.anthropic.com/v1/mcp/';
const CLAUDE_CONNECTOR_BETA_HEADER = 'mcp-servers-2025-12-04';

// The proxy checks the operator's ambient Claude CLI token — not any credential
// of the connected provider. That token lives ~8h and only a running Claude
// Code process rotates it on disk (token.ts: Balabash never owns that flow):
// when no thread is active at the boundary, the file holds an expired token
// until the next turn of any session on this box, and every proxy call in that
// window dies with 401 "OAuth access token has expired". The error is named so
// the failure reads as what it is — nothing in Balabash, on claude.ai or at the
// provider needs re-authorizing; the next call after a turn succeeds.
export class ClaudeConnectorAuthError extends Error {
  readonly expiresAt: number | null;

  constructor(serverName: string, credentials: OperatorCredentials, detail: string | null) {
    const ttl = tokenTtlMs(credentials);
    const minutes = ttl == null ? null : Math.round(Math.abs(ttl) / 60_000);
    const state =
      ttl == null
        ? 'was rejected by the proxy'
        : ttl <= 0
          ? `expired ${minutes}min ago`
          : `was rejected by the proxy (expires in ${minutes}min)`;

    super(
      `Claude connector "${serverName}" is unavailable: the operator's ambient Claude CLI login token ` +
        `(${credentials.source === 'env' ? 'CLAUDE_CODE_OAUTH_TOKEN' : '~/.claude/.credentials.json'}) ${state}` +
        `${detail ? ` — ${detail}` : ''}. It rotates by itself at the next turn of any Claude Code session on ` +
        'this box; nothing in Balabash or at the provider needs re-authorizing — retry later.',
    );
    this.name = 'ClaudeConnectorAuthError';
    this.expiresAt = credentials.expiresAt;
  }
}

// One warning per token generation: the first failure of a window goes to the
// log with the diagnosis, the rest of the window (a tick every few minutes)
// stays quiet; a rotated token (new expiresAt) arms the warning again.
let warnedExpiresAt: number | null | undefined;

function warnOnce(error: ClaudeConnectorAuthError): void {
  if (warnedExpiresAt !== undefined && warnedExpiresAt === error.expiresAt) {
    return;
  }

  warnedExpiresAt = error.expiresAt;
  console.warn(`[tools] ${error.message}`);
}

// The proxy's 401 body is an Anthropic API error envelope; its message is the
// only diagnostic the proxy gives ("OAuth access token has expired. …").
function proxyErrorMessage(body: string | null): string | null {
  if (!body) {
    return null;
  }

  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } };

    return typeof parsed.error?.message === 'string' ? parsed.error.message : body.slice(0, 200);
  } catch {
    return body.slice(0, 200);
  }
}

// The ambient token rotates on disk (~8h); read it fresh on every request so
// a long-lived connection survives rotation. A token the file already shows
// as expired is not sent at all (the answer is known); a 401 from the proxy is
// translated the same way. The client session id is the proxy's required
// correlation header — one per transport lifetime.
function createClaudeConnectorFetch(serverName: string): FetchLike {
  const clientSessionId = crypto.randomUUID();

  return async (url, init) => {
    const credentials = await resolveOperatorCredentials();
    const ttl = tokenTtlMs(credentials);

    if (ttl != null && ttl <= 0) {
      const error = new ClaudeConnectorAuthError(serverName, credentials, null);

      warnOnce(error);
      throw error;
    }

    const headers = new Headers(init?.headers);

    headers.set('Authorization', `Bearer ${credentials.accessToken}`);
    headers.set('X-Mcp-Client-Session-Id', clientSessionId);
    headers.set('anthropic-beta', CLAUDE_CONNECTOR_BETA_HEADER);

    const response = await fetch(url, { ...init, headers });

    if (response.status === 401) {
      const body = await response.text().catch(() => null);
      const error = new ClaudeConnectorAuthError(serverName, credentials, proxyErrorMessage(body));

      warnOnce(error);
      throw error;
    }

    return response;
  };
}

export async function probeExternalService(
  serverName: string,
  config: ExternalServerConfig,
): Promise<void> {
  const transport =
    config.transport === 'stdio'
      ? new StdioClientTransport({
          command: config.command,
          args: config.args ?? [],
          env: config.env ? { ...(process.env as Record<string, string>), ...config.env } : undefined,
        })
      : config.transport === 'claude-connector'
        ? new StreamableHTTPClientTransport(new URL(config.serverId, CLAUDE_CONNECTOR_PROXY_BASE), {
            fetch: createClaudeConnectorFetch(serverName),
          })
        : new StreamableHTTPClientTransport(new URL(config.url), {
            requestInit: config.headers ? { headers: config.headers } : undefined,
          });

  const client = new Client(CLIENT_INFO);

  try {
    await client.connect(transport);
    await client.listTools();
  } finally {
    try {
      if (transport instanceof StreamableHTTPClientTransport) await transport.terminateSession();
    } finally {
      await client.close();
    }
  }
}
