// The configuration of a Balabash Codex session: the `--config` overrides
// every `codex exec` invocation of the session carries (a turn is one
// invocation, resumed by thread id — sdk-session.ts). No config.toml is
// written into the app's CODEX_HOME (codex-home.ts): this object is the
// whole user layer the session sees, and a pure function of what the
// session needs — the brief and the bridge's address.

import type { CodexOptions } from '@openai/codex-sdk';

export type CodexSessionConfig = NonNullable<CodexOptions['config']>;

// Reasoning summaries are what the feed's "Thought" row shows for a Codex
// session (the session journal maps the `reasoning` item to
// session.thinking). Codex asks the API for `summary: "auto"` unless told
// otherwise, and "auto" resolves to the model's own default — for gpt-6-astra
// the CLI's model metadata says `default_reasoning_summary: "none"`, so the
// reasoning items came back with an empty summary and the SDK stream never
// carried a `reasoning` item (the live log had no Codex thought at all,
// 2026-10-10). The thread options of the SDK have no field for it; the
// config key does the job: with "detailed" the `item.completed` of the
// reasoning item arrives with the summary's text (probed with `codex exec
// --json`, 2026-10-10). "detailed" over "concise": the row shows the thought
// itself, as the Claude feed does, not a headline.
export const CODEX_REASONING_SUMMARY = 'detailed';

// The name of the bridge's MCP server in the session (the journal tells its
// calls apart from other MCP servers by it).
export const BRIDGE_SERVER = 'balabash';

// What a session may switch on beyond the base: Codex's built-in image
// generation (the image_gen tool inside exec plus the bundled imagegen skill)
// — the image_generator agent's own means; off everywhere else.
export type CodexSessionFeatures = { imageGeneration: boolean };

// Codex's bundled skills (CODEX_HOME/skills/.system) by name: all but
// imagegen have no place in a Balabash session — openai-docs fires on the
// word Codex, skill-installer writes into the app's codex-home, skill-creator
// authors skills nobody asked for. Without image generation the whole bundle
// goes (`skills.bundled.enabled`); with it, the three are turned off one by
// one and imagegen stays listed.
const BUNDLED_SKILLS_OFF = ['openai-docs', 'skill-installer', 'skill-creator'];

export function codexSessionConfig(instructions: string, bridgeUrl: string, enabled: CodexSessionFeatures = { imageGeneration: false }): CodexSessionConfig {
  return {
    // The brief is a developer message ahead of the conversation — the
    // system-prompt position — not a prefix of the first user turn.
    developer_instructions: instructions,
    model_reasoning_summary: CODEX_REASONING_SUMMARY,
    mcp_servers: {
      [BRIDGE_SERVER]: {
        url: bridgeUrl,
        required: true,
        default_tools_approval_mode: 'approve',
      },
    },
    // Codex reads AGENTS.md from the git root down to cwd; the workbench
    // lives inside the Balabash repository, so that chain would inject
    // the repo's own AGENTS.md into a workbench session. Project docs
    // are off: the brief tells the agent which AGENTS.md to read.
    project_doc_max_bytes: 0,
    // ChatGPT apps/connectors, plugins and the memories store are not
    // part of the Balabash tool set: integrations are the run's tool
    // bundle, memory is the workspace. Codex's own agent team
    // (multi_agent) stays on — its native sub-agents work inside the
    // session, next to the bridge's Balabash sub-agents (spawn_agent).
    features: {
      apps: false,
      plugins: false,
      memories: false,
      // Goals (per-turn token and time budgets the model sets itself) — the
      // platform keeps the limits; the tools only cost context.
      goals: false,
      image_generation: enabled.imageGeneration,
    },
    skills: enabled.imageGeneration
      ? { config: BUNDLED_SKILLS_OFF.map(name => ({ name, enabled: false })) }
      : { bundled: { enabled: false } },
  };
}
