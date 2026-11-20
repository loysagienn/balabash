import crypto from 'node:crypto';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import { resolveOperatorCredentials, tokenTtlMs, type OperatorCredentials } from '../adapters/ccr/token.ts';
import { CapabilityError } from '../catalog/errors.ts';
import type { ExternalServer } from './mcp-client.ts';

// Anthropic's MCP proxy for claude.ai connectors: the upstream OAuth tokens
// (Slack etc.) live on claude.ai; the proxy authenticates by the operator's
// claude.ai access token. Undocumented alpha, mirrored from the Claude Code
// CLI (MCP_PROXY_URL / MCP_PROXY_PATH in its build constants).
const CLAUDE_CONNECTOR_PROXY_BASE = 'https://mcp-proxy.anthropic.com/v1/mcp/';
const CLAUDE_CONNECTOR_BETA_HEADER = 'mcp-servers-2025-12-04';

// CLI credentials on disk rotate during Claude Code turns. An environment
// override instead has to be replaced by the operator.
function authError(serverName: string, credentials: OperatorCredentials, detail?: string | null): CapabilityError {
  const ttl = tokenTtlMs(credentials);
  const state = ttl !== null && ttl <= 0 ? 'has expired' : 'was rejected by the proxy';
  const recovery = credentials.source === 'env'
    ? 'Replace CLAUDE_CODE_OAUTH_TOKEN in the service environment.'
    : 'A turn by any local Claude Code agent refreshes the CLI login. If none is running, tell the operator.';
  return new CapabilityError('auth_required',
    `Claude connector "${serverName}": the operator’s Claude CLI token ${state}. ${detail ? detail + '. ' : ''}${recovery}`);
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
    const credentials = await resolveOperatorCredentials().catch(() => {
      throw new CapabilityError('auth_required', 'Ask the operator to sign in with the Claude CLI on this host.');
    });
    const ttl = tokenTtlMs(credentials);

    if (ttl != null && ttl <= 0) {
      throw authError(serverName, credentials);
    }

    const headers = new Headers(init?.headers);

    headers.set('Authorization', `Bearer ${credentials.accessToken}`);
    headers.set('X-Mcp-Client-Session-Id', clientSessionId);
    headers.set('anthropic-beta', CLAUDE_CONNECTOR_BETA_HEADER);

    const response = await fetch(url, { ...init, headers });

    if (response.status === 401) {
      const body = await response.text().catch(() => null);
      throw authError(serverName, credentials, proxyErrorMessage(body));
    }

    return response;
  };
}

export function connectorServer(name: string, serverId: string): ExternalServer {
  return {
    title: name,
    url: new URL(serverId, CLAUDE_CONNECTOR_PROXY_BASE).href,
    fetch: createClaudeConnectorFetch(name),
  };
}
