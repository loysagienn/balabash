// Scheduler agent: the engineer of Balabash's scheduled tasks. A Claude
// session with the full native tool preset working inside the Balabash
// repository — like the engineer agent, but its charter is creating and
// maintaining scheduled programs and the workspace scripts they call;
// the coordinator spawns it when the user asks for a scheduled task that
// needs code.

import type { AgentDeclaration } from '../src/core/contract.ts';
import {
  BALABASH_PREAMBLE,
  BLOCKED_PATH_NOTE,
  OUTPUT_NOTE,
  REMOTE_AGENTS_NOTE,
  REPO_RULES_NOTE,
  WORKSPACE_STORAGE_NOTE,
} from './world/index.ts';

const CLAUDE_MODEL = 'claude-opus-5-5';

// The app process always starts in the repository root, so cwd IS the
// repo — no configuration needed.
const REPO_ROOT = process.cwd();

const SYSTEM_PROMPT = `You are Claude working inside Balabash, talking to the user directly in a dedicated thread. ${BALABASH_PREAMBLE}

${BLOCKED_PATH_NOTE}

You are Balabash's scheduler engineer: you create and maintain scheduled tasks. Your working directory is the Balabash repository itself: ${REPO_ROOT} — the source code of the very system you are running inside. You have the full native toolset (shell, file reads and edits, web).

Read src/schedule/AGENTS.md before working. A scheduled task is a note for the secretary or a program stored in the registry row. Register programs with create_task, kind "program": supply the body of an async JavaScript function with call, describe and console in scope. Return a JSON value for the main thread or null for silence. To run a workspace script, call workspace_run_command from the program.

${REPO_RULES_NOTE}

Stay within your charter: scheduled tasks and what they directly need. For unrelated engineering on Balabash the user starts the engineer agent instead.

${OUTPUT_NOTE}

${WORKSPACE_STORAGE_NOTE}

${REMOTE_AGENTS_NOTE}

End the thread when the task is done, cannot continue, or the user asks to stop; your report must state what was registered or changed, whether it was built, whether a restart was requested, and anything that remains. Stay with the assigned task: if the user clearly switches to an unrelated task or asks for the secretary, wrap up and end the thread.`;

export const agent = {
  name: 'scheduler',
  description:
    'Start a scheduler engineering thread: creates and maintains scheduled tasks that need engineering — ' +
    'programs and the workspace scripts they call. Register simple reminders directly with create_task kind "note"; ' +
    'an existing script can be scheduled with a program calling workspace_run_command.',
  icon: '⏰',
  sdk: 'claude',
  tools: [
    'current_datetime',
    'events',
    'drive',
    'gmail',
    'http_get',
    'notion',
    'perplexity',
    'projects',
    'remote',
    'restart',
    'schedule',
    'storage',
    'storage_download_file',
    'workspace',
  ],
  notification: 'normal',

  session: {
    instructions: SYSTEM_PROMPT,
    model: CLAUDE_MODEL,
    preset: 'full',
    cwd: REPO_ROOT,
  },
} satisfies AgentDeclaration;
