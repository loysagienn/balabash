// Manager agent: a general-purpose task thread — the user talks to it
// directly in its own topic and hands it everyday tasks; it acts through the
// Balabash tool bundle plus the full native tool preset working on the
// per-user workbench (the workspace file area itself is its cwd, like the
// power_point agent), and can spawn the browser sub-agent for operating real
// websites. The brief and the passport are the manager role's (roles/manager),
// shared with the codex agent — the same manager on OpenAI Codex. Fully
// declarative: the platform's session runner drives the SDK session, the
// channel binding and the base verbs (end_thread, send_file, spawn_agent).

import type { AgentDeclaration } from '../src/core/contract.ts';
import { workspaceFilesDir } from '../src/workspace/layout.ts';
import { MANAGER_AGENTS, MANAGER_INSTRUCTIONS, MANAGER_TOOLS } from './roles/manager.ts';

export const agent = {
  name: 'manager',
  description:
    "Start a manager thread — a general-purpose assistant that takes on the user's tasks and sees them " +
    'through using the connected integrations, and can operate a real browser via a sub-agent when a task ' +
    'requires it. The thread opens as a separate topic where the user talks to the manager directly; a task ' +
    'may be given upfront, or the prompt may say the thread starts open-ended — the manager then greets the ' +
    'user and takes tasks in the topic. Start it when the user asks for the manager or hands over a task of ' +
    'this kind.',
  icon: '🎩',
  sdk: 'claude',
  tools: MANAGER_TOOLS,
  agents: MANAGER_AGENTS,
  notification: 'normal',

  session: {
    instructions: MANAGER_INSTRUCTIONS,
    model: 'claude-opus-5-5',
    preset: 'full',
    cwd: (userId: string) => workspaceFilesDir(userId),
  },
} satisfies AgentDeclaration;
