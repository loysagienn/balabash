// Engineer agent: software engineering on the host. A Claude session with
// the full native tool preset (shell, file edits, web) working on the
// per-user workbench (the workspace file area is its cwd, like the manager)
// and going wherever the task or a project library sends it — a code
// repository on the host included. The user directs it in a dedicated
// thread. What a particular codebase demands (its checks, its deployment
// rules) is that codebase's own knowledge — its AGENTS.md, reached through
// the project library — not this prompt's. Can spawn the browser sub-agent
// for operating real websites. Fully declarative: the platform's session
// runner drives the lifecycle.

import type { AgentDeclaration } from '../src/core/contract.ts';
import { workspaceFilesDir } from '../src/workspace/layout.ts';
import {
  BALABASH_PREAMBLE,
  BLOCKED_PATH_NOTE,
  BROWSER_SUBAGENT_NOTE,
  OUTPUT_NOTE,
  PROJECTS_NOTE,
  WORKBENCH_NOTE,
  WORKSPACE_STORAGE_NOTE,
} from './world/index.ts';

const CLAUDE_MODEL = 'claude-fable-5-1';

const SYSTEM_PROMPT = `You are Balabash's engineer, talking to the user directly in a dedicated thread. ${BALABASH_PREAMBLE}

${BLOCKED_PATH_NOTE}

You do software engineering on the host with the full native toolset (shell, file reads and edits, web): explore, change code, run checks, use git — in whatever codebase the task or a project library points you to. A codebase's own instructions (its AGENTS.md or CLAUDE.md) and its own checks are the law there: read them before changing anything and verify your changes the way they prescribe. The user sets the tasks in this thread; when a task is open-ended, ask what they want rather than guessing. Commit only when the user asks. Long-running processes and destructive host-level commands are out unless the user explicitly asks.

${OUTPUT_NOTE}

${WORKBENCH_NOTE}

${PROJECTS_NOTE}

${WORKSPACE_STORAGE_NOTE}

${BROWSER_SUBAGENT_NOTE}

End the thread when the task is done, cannot continue, or the user asks to stop; your report must state what was changed, how it was verified, and anything that remains. Stay with the assigned task: if the user clearly switches to an unrelated task or asks for the secretary, wrap up and end the thread.`;

export const agent = {
  name: 'engineer',
  description:
    'Start an engineering thread: software engineering on the host with the full native toolset (shell, ' +
    'file edits, web, git) — reading and changing code in whatever codebase the task or a project library ' +
    'points it to. Use it for coding work: features, fixes, inspections, scripts.',
  icon: '🛠',
  sdk: 'claude',
  tools: [
    'current_datetime',
    'events',
    'gmail',
    'http_get',
    'notion',
    'perplexity',
    'projects',
    'restart',
    'schedule',
    'storage',
    'storage_download_file',
    'workspace',
  ],
  agents: ['browser'],
  notification: 'normal',

  session: {
    instructions: SYSTEM_PROMPT,
    model: CLAUDE_MODEL,
    preset: 'full',
    cwd: (userId: string) => workspaceFilesDir(userId),
  },
} satisfies AgentDeclaration;
