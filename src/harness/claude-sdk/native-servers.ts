// First-party MCP servers of the Claude Code harness: remote servers the CLI
// authenticates itself with the host's Claude login (no Balabash OAuth flow
// is possible — their authorization is a non-public first-party mechanism).
// An agent opts in by name (SessionAgentSpec.nativeServers); the config is
// handed to the SDK verbatim next to the Balabash bridge, and the server's
// tools reach the inner model as mcp__<name>__<tool>. Authorization is an
// installation-level fact: the operator signs in once on the host in an
// interactive Claude Code session (`claude mcp add … && /design-login`).

import type { NativeMcpServerName } from '../../core/contract.ts';

type NativeMcpServerConfig = { type: 'http'; url: string };

export const NATIVE_MCP_SERVERS: Record<NativeMcpServerName, NativeMcpServerConfig> = {
  // Claude Design (claude.ai/design): design-system and prototype projects.
  // Bearer: the /design-login credential stored by the host Claude Code.
  claude_design: { type: 'http', url: 'https://api.anthropic.com/v1/design/mcp' },
};

export function nativeMcpServers(
  names: readonly NativeMcpServerName[] | undefined,
): Record<string, NativeMcpServerConfig> {
  return Object.fromEntries((names ?? []).map(name => [name, NATIVE_MCP_SERVERS[name]]));
}
