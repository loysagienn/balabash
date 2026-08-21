// The AgentSdkSession factory (§8.2): the contract shape an agent receives via
// ctx.harness.sdkSession(). Wraps the raw Claude session and the MCP bridge.
// In the default bridge-only preset the inner model sees the bridge and
// nothing else — no native claude_code tools, no user-scope MCP servers or
// settings. The 'full' preset (the engineer agent) keeps the bridge
// and unlocks the native claude_code toolset plus project settings from cwd.
// Prompt cache lives inside the SDK.
//
// The factory is synchronous per contract while the bridge setup is async:
// pushes arriving before the session is up are queued, and `turns` awaits
// the setup before iterating.

import path from 'node:path';
import type { AgentSdkSession, SdkSessionOptions, SdkTurn, ToolsApi } from '../../core/contract.ts';
import { startClaudeSession } from './session.ts';
import type { ClaudeSession } from './session.ts';
import { createBridgeServer } from './bridge.ts';
import type { BridgeServer } from './bridge.ts';

export type SdkSessionDeps = {
  tools: ToolsApi;
  // Working directory of the inner session — the run's persistent stateDir.
  cwd: string;
};

// process.env values can be undefined; the SDK wants Record<string, string>.
function mergeEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};

  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) env[name] = value;
  }

  return { ...env, ...extra };
}

export function createClaudeSession(options: SdkSessionOptions, deps: SdkSessionDeps): AgentSdkSession {
  let closed = false;
  let session: ClaudeSession | null = null;
  let bridge: BridgeServer | null = null;
  const pendingInputs: string[] = [];

  const setup: Promise<ClaudeSession | null> = (async () => {
    bridge = await createBridgeServer({
      tools: deps.tools,
      extraTools: options.extraTools ?? [],
    });

    if (closed) {
      return null;
    }

    const full = options.preset === 'full';

    const created = startClaudeSession(options.initialMessage, {
      cwd: options.cwd ?? deps.cwd,
      // SDK `env` replaces the subprocess environment entirely, so merge the
      // extra variables over the inherited app environment.
      ...(options.env ? { env: mergeEnv(options.env) } : {}),
      ...(options.model ? { model: options.model } : {}),
      // Reasoning effort; the platform default is explicit rather than
      // trusting the SDK default to stay 'high'.
      effort: options.effort ?? 'high',
      systemPrompt: options.instructions,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      // Bridge-only: the inner session gets the Balabash bridge and nothing
      // else. Full: the native claude_code preset stays on and project-level
      // settings (CLAUDE.md, .claude/) load from cwd — plus the repo's
      // platform plugin (skills like balabash:app-builder): workbench agents
      // run with cwd in the workspace file area, where repo skills are
      // invisible, so the plugin path delivers them (design №15 of /apps).
      // skipMcpDiscovery: the MCP surface stays owned by the Balabash bridge.
      ...(full
        ? {
            settingSources: ['project' as const],
            plugins: [{ type: 'local' as const, path: path.resolve('plugins', 'balabash'), skipMcpDiscovery: true }],
          }
        : { tools: [], settingSources: [] }),
      strictMcpConfig: true,
      mcpServers: { balabash: { type: 'sdk', name: 'balabash', instance: bridge.server } },
    });

    // close() may have won the race while the session was starting.
    if (closed) {
      created.close();

      return null;
    }

    session = created;

    for (const text of pendingInputs.splice(0)) {
      created.push(text);
    }

    return created;
  })();

  async function* turns(): AsyncGenerator<SdkTurn> {
    const created = await setup;

    if (!created) {
      return;
    }

    for await (const message of created.messages) {
      if (message.type !== 'result') {
        continue;
      }

      if (message.subtype !== 'success') {
        throw new Error(`SDK session turn failed: ${message.subtype}`);
      }

      yield { text: typeof message.result === 'string' ? message.result.trim() : '' };
    }
  }

  return {
    push: text => {
      if (closed) {
        throw new Error('SDK session is closed');
      }

      if (session) {
        session.push(text);
      } else {
        pendingInputs.push(text);
      }
    },

    turns: turns(),

    syncTools: async () => {
      // Setup failure surfaces through `turns`; syncTools stays quiet.
      await setup.catch(() => null);
      await bridge?.syncTools();
    },

    close: () => {
      if (closed) {
        return;
      }

      closed = true;
      session?.close();
      // A session still starting is closed by the race check in setup.
    },
  };
}
