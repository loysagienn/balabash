// The AgentSdkSession factory (§8.2): the contract shape an agent receives via
// ctx.harness.sdkSession(). Wraps the raw Claude session and the MCP bridge.
// In the default bridge-only preset the inner model sees the bridge and
// nothing else — no native claude_code tools, no user-scope MCP servers or
// settings. The 'full' preset (the workbench agents) keeps the bridge
// and unlocks the native claude_code toolset plus project settings from cwd.
// Claude Code Artifacts (the harness's Artifact tools, claude.ai) are off by
// default in SDK sessions; a session that asks for them gets the CLI's switch
// through its environment. Prompt cache lives inside the SDK.
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
import { emitSdkMessage, emitSdkSessionEnd } from './stream-tap.ts';
import { registerContextUsageProvider } from './context-usage.ts';
import { planLimits } from './plan-limits.ts';
import { DEFAULT_EFFORT } from '../default-effort.ts';

// Claude Code's switch for its Artifact tools in SDK sessions (off by
// default there), and no browser tab on publish.
const ARTIFACTS_ENV: Record<string, string> = { CLAUDE_CODE_ARTIFACT: '1', CLAUDE_CODE_ARTIFACT_AUTO_OPEN: '0' };

// Native Claude Code tools withheld from full-preset sessions (the agents'
// context composition, project library claude-prompt-composition.md): the
// Workflow orchestrator (Balabash has the thread tree), claude.ai routines
// (the scheduler), desktop push notifications (thread notifications) and git
// worktree switching (never asked for). The in-session cron stays: with
// ScheduleWakeup it is how an agent keeps watch over an external state the
// harness cannot notify it about (a CI run) — the /loop skill's two modes.
// ReportFindings exists for the code-review skill's output; it leaves with it.
const NATIVE_TOOLS_OFF = ['Workflow', 'RemoteTrigger', 'PushNotification', 'EnterWorktree', 'ExitWorktree', 'ReportFindings'];

// Bundled Claude Code skills hidden from the model (`off`: neither listed nor
// invocable): each configures the CLI itself or a terminal (update-config,
// keybindings-help, fewer-permission-prompts — a headless session has no
// settings to edit and no permission prompts), writes a CLAUDE.md into a
// repository (init — the project libraries hold the instructions), drives
// claude.ai routines (schedule — the scheduler is Balabash's), authors mods
// of the CLI (plugin-authoring), or is a situational review or launch
// routine the agents never reached for (code-review with its ReportFindings
// tool, simplify, security-review, run). Each had zero invocations in the
// journal when it was turned off.
const BUNDLED_SKILLS_OFF = [
  'update-config',
  'keybindings-help',
  'fewer-permission-prompts',
  'init',
  'schedule',
  'plugin-authoring',
  'code-review',
  'simplify',
  'security-review',
  'run',
];

// Bundled skills listed by name only (`name-only`: invocable, but without the
// description that makes the model reach for them by itself): claude-api, a
// Messages API reference whose description fires on any mention of Claude —
// in this codebase, most tasks — while the skill itself does not cover the
// Agent SDK the agents run on. Named explicitly, it still loads whole.
const BUNDLED_SKILLS_NAME_ONLY = ['claude-api'];

export type SdkSessionDeps = {
  tools: ToolsApi;
  // Working directory of the inner session — the run's persistent stateDir.
  cwd: string;
  // When set, every raw SDKMessage of the inner stream is published on the
  // stream tap under this thread — the feed of a surface adapter's live
  // mirror (CCR) and of the session journal, which also hears the session's
  // end on close() — and the thread's context-usage provider is registered.
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
  // Reasoning effort; the platform default is explicit (default-effort.ts)
  // rather than trusting the SDK default to stay 'high'. Also stamped onto
  // the mirrored init frame: the inner CLI omits `effort` on the SDK path,
  // and the app reads the session's effort from its newest init frame.
  const effort = options.effort ?? DEFAULT_EFFORT;
  // Undoes the thread's context-usage and usage registrations (deps.threadId sessions).
  let unregisterContextUsage: (() => void) | null = null;
  let unregisterUsage: (() => void) | null = null;
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
      // extra variables over the inherited app environment. Artifacts: the
      // CLI's own switch; no browser opens on a server.
      ...(options.env || options.artifacts
        ? { env: mergeEnv({ ...(options.artifacts ? ARTIFACTS_ENV : {}), ...(options.env ?? {}) }) }
        : {}),
      ...(options.model ? { model: options.model } : {}),
      // The continuation of a session the CLI persisted (a run resumed after
      // an app restart): same cwd, the transcript is found by its id.
      ...(options.resume ? { resume: options.resume } : {}),
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
      // skipMcpDiscovery: the MCP surface stays owned by the Balabash bridge.
      ...(full
        ? {
            settingSources: ['project' as const],
            plugins: [{ type: 'local' as const, path: path.resolve('plugins', 'balabash'), skipMcpDiscovery: true }],
            // Native tools no Balabash agent has a use for: each duplicates a
            // Balabash mechanism (the thread tree, the scheduler, thread
            // notifications) or has no application in a headless session.
            // Workflows go off through the setting so the workflow-authoring
            // skill and the "ultracode" trigger leave with the tool.
            disallowedTools: NATIVE_TOOLS_OFF,
            settings: {
              disableWorkflows: true,
              skillOverrides: Object.fromEntries([
                ...BUNDLED_SKILLS_OFF.map(name => [name, 'off' as const]),
                ...BUNDLED_SKILLS_NAME_ONLY.map(name => [name, 'name-only' as const]),
              ]),
            },
          }
        : { tools: [], settingSources: [] }),
      strictMcpConfig: true,
      mcpServers: {
        balabash: { type: 'sdk', name: 'balabash', instance: bridge.server },
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
    // Likewise the plan's rate limits (plan-limits.ts): any live session
    // measures them for the console.
    if (deps.threadId) {
      unregisterContextUsage = registerContextUsageProvider(deps.threadId, opts => created.getContextUsage(opts));
      unregisterUsage = planLimits.registerProvider(deps.threadId, () => created.getUsage());
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
      unregisterUsage?.();
      session?.close();
      // A session still starting is closed by the race check in setup.

      if (deps.threadId) {
        emitSdkSessionEnd(deps.threadId);
      }
    },
  };
}
