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
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { AgentSdkSession, SdkSessionOptions, SdkTurn, ToolsApi } from '../../core/contract.ts';
import { startClaudeSession } from './session.ts';
import type { ClaudeSession } from './session.ts';
import { createBridgeServer } from './bridge.ts';
import type { BridgeServer } from './bridge.ts';
import { mergeEnv } from '../env.ts';
import { nativeMcpServers } from './native-servers.ts';
import { emitSdkMessage } from './stream-tap.ts';
import { registerContextUsageProvider } from './context-usage.ts';

export type SdkSessionDeps = {
  tools: ToolsApi;
  // Working directory of the inner session — the run's persistent stateDir.
  cwd: string;
  // When set, every raw SDKMessage of the inner stream is published on the
  // stream tap under this thread — the feed of a surface adapter's live
  // mirror (CCR), and the thread's context-usage provider is registered.
  threadId?: string;
};

// The init frame with the session's effort when the CLI left it out (the SDK
// path does; Remote Control hosts publish it and the app displays it).
function withEffort(message: SDKMessage, effort: NonNullable<SdkSessionOptions['effort']>): SDKMessage {
  if (message.type !== 'system' || message.subtype !== 'init' || message.effort !== undefined) {
    return message;
  }

  return { ...message, effort };
}

export function createClaudeSession(options: SdkSessionOptions, deps: SdkSessionDeps): AgentSdkSession {
  let closed = false;
  let session: ClaudeSession | null = null;
  let bridge: BridgeServer | null = null;
  const pendingInputs: string[] = [];
  // Reasoning effort; the platform default is explicit rather than trusting
  // the SDK default to stay 'high'. Also stamped onto the mirrored init
  // frame: the inner CLI omits `effort` on the SDK path, and the app reads
  // the session's effort from its newest init frame.
  const effort = options.effort ?? 'high';
  // Undoes the thread's context-usage registration (deps.threadId sessions).
  let unregisterContextUsage: (() => void) | null = null;
  // Set by interrupt(), consumed by the next result frame: an interrupted
  // turn may close with an error subtype — that is the expected outcome of
  // the stop, not a turn failure.
  let interruptPending = false;
  // Turns not yet closed by a result frame: one per pushed message (the
  // initial message included). interrupt() on zero is a no-op — otherwise a
  // Stop pressed on an idle agent would swallow its next real turn.
  let openTurns = 1;

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
      effort,
      systemPrompt: options.instructions,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      // Bridge-only: the inner session gets the Balabash bridge and nothing
      // else. Full: the native claude_code preset stays on and project-level
      // settings (CLAUDE.md, .claude/) load from cwd — plus the repo's
      // platform plugin (skills like balabash:app-builder): workbench agents
      // run with cwd in the workspace file area, where repo skills are
      // invisible, so the plugin path delivers them (design №15 of /apps).
      // skipMcpDiscovery: the MCP surface stays owned by the Balabash bridge —
      // plus the first-party harness servers the agent opted into (see
      // native-servers.ts), which the CLI authenticates itself.
      ...(full
        ? {
            settingSources: ['project' as const],
            plugins: [{ type: 'local' as const, path: path.resolve('plugins', 'balabash'), skipMcpDiscovery: true }],
          }
        : { tools: [], settingSources: [] }),
      strictMcpConfig: true,
      mcpServers: {
        balabash: { type: 'sdk', name: 'balabash', instance: bridge.server },
        ...nativeMcpServers(options.nativeServers),
      },
    });

    // close() may have won the race while the session was starting.
    if (closed) {
      created.close();

      return null;
    }

    session = created;

    // A surface may ask for the context-window occupancy of this thread's
    // session (the CCR plane answers the app's get_context_usage with it).
    if (deps.threadId) {
      unregisterContextUsage = registerContextUsageProvider(deps.threadId, opts => created.getContextUsage(opts));
    }

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
      if (deps.threadId) {
        emitSdkMessage(deps.threadId, withEffort(message, effort));
      }

      if (message.type !== 'result') {
        continue;
      }

      openTurns = Math.max(0, openTurns - 1);

      if (interruptPending) {
        interruptPending = false;
        yield { text: '', interrupted: true };

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

      openTurns += 1;

      if (session) {
        session.push(text);
      } else {
        pendingInputs.push(text);
      }
    },

    turns: turns(),

    interrupt: async () => {
      if (closed) {
        return;
      }

      const created = await setup.catch(() => null);

      if (!created || closed || openTurns === 0) {
        return;
      }

      interruptPending = true;

      try {
        await created.interrupt();
      } catch (error) {
        console.error('[sdk-session] interrupt failed:', error);
      }
    },

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
      unregisterContextUsage?.();
      session?.close();
      // A session still starting is closed by the race check in setup.
    },
  };
}
