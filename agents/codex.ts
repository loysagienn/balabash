// Codex agent: the manager on OpenAI Codex. Same brief, same tool passport,
// same browser sub-agent and the same workbench (the workspace file area as
// cwd) as the manager agent — the role is shared through roles/manager; only
// the backend differs: an OpenAI Codex session with its native tool set
// (shell, file editing, web search) plus the run's Balabash MCP bundle and
// the standard base verbs. The session runs in an isolated CODEX_HOME
// (harness/codex-sdk/codex-home), so nothing from the host user's ~/.codex —
// personal AGENTS.md, MCP servers, memories — reaches it. Fully declarative:
// the platform's session runner drives the lifecycle.

import type { AgentDeclaration } from '../src/core/contract.ts';
import { workspaceFilesDir } from '../src/workspace/layout.ts';
import { MANAGER_AGENTS, MANAGER_INSTRUCTIONS, MANAGER_TOOLS } from './roles/manager.ts';

export const agent = {
  name: 'codex',
  description:
    'Start a manager thread on OpenAI Codex — the same general-purpose manager (same brief, tools, workbench ' +
    'and browser sub-agent) as the manager agent, running as an autonomous Codex session instead of Claude. ' +
    'The thread opens as a separate topic where the user talks to it directly; a task may be given upfront, ' +
    'or the prompt may say the thread starts open-ended. Start it when the user asks for Codex explicitly, ' +
    'or wants a task done by the OpenAI model.',
  icon: '🤖',
  sdk: 'codex',
  tools: MANAGER_TOOLS,
  agents: MANAGER_AGENTS,
  notification: 'normal',

  session: {
    instructions: MANAGER_INSTRUCTIONS,
    model: 'gpt-6-astra',
    effort: 'high',
    preset: 'full',
    cwd: (userId: string) => workspaceFilesDir(userId),
  },
} satisfies AgentDeclaration;
