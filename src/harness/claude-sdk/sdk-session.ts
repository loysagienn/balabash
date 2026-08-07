// The SdkSession factory (§8.2): the contract shape an agent receives via
// ctx.harness.sdkSession(). Wraps the raw Claude session and the MCP bridge:
// only the bridge is exposed to the inner model — no native claude_code
// tools, no user-scope MCP servers or settings. Prompt cache lives inside
// the SDK.
//
// The factory is synchronous per contract while the bridge setup is async:
// pushes arriving before the session is up are queued, and `turns` awaits
// the setup before iterating.

import type { SdkSession, SdkSessionOptions, SdkTurn, FilesApi, ToolsApi } from '../../core/contract.ts';
import { startClaudeSession } from './session.ts';
import type { ClaudeSession } from './session.ts';
import { createBridgeServer } from './bridge.ts';
import type { BridgeServer } from './bridge.ts';

export type SdkSessionDeps = {
  tools: ToolsApi;
  files: FilesApi;
  // Working directory of the inner session — the run's persistent stateDir.
  cwd: string;
};

export function createSdkSession(options: SdkSessionOptions, deps: SdkSessionDeps): SdkSession {
  let closed = false;
  let session: ClaudeSession | null = null;
  let bridge: BridgeServer | null = null;
  const pendingInputs: string[] = [];

  const setup: Promise<ClaudeSession | null> = (async () => {
    bridge = await createBridgeServer({
      tools: deps.tools,
      files: deps.files,
      extraTools: options.extraTools ?? [],
    });

    if (closed) {
      return null;
    }

    const created = startClaudeSession(options.initialMessage, {
      cwd: deps.cwd,
      ...(options.model ? { model: options.model } : {}),
      systemPrompt: options.instructions,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      // The inner session gets the Balabash bridge and nothing else.
      tools: [],
      strictMcpConfig: true,
      settingSources: [],
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
