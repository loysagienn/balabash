// Scheduler agent: the engineer of Balabash's scheduled tasks. A Claude
// session with the full native tool preset working inside the Balabash
// repository — like the engineer agent, but its charter is creating and
// maintaining scheduled tasks: run(ctx) bodies in the workspace's tasks/
// directory (live, no build) or in the repository catalog, their registry
// rows (create_task). Full host access;
// the coordinator spawns it when the user asks for a scheduled task that
// needs code.

import type { AgentDeclaration } from '../src/core/contract.ts';
import {
  BALABASH_PREAMBLE,
  BLOCKED_PATH_NOTE,
  OUTPUT_NOTE,
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

A scheduled task is a registry row (slug, kind, trigger) plus — for kind 'code' — a run(ctx) body under the same slug. Bodies normally live in the WORKSPACE: the directory $WORKSPACE_TASKS_DIR of your shell environment (data/workspace/<userId>/tasks/), one <slug>.ts per task, imported fresh at every fire — no build, no restart, run_task tries it right away. The repository's tasks/ catalog is for product code only (bundled, built and restarted). The regulations live in tasks/AGENTS.md: read it before working — it is the law of the contract, the execution semantics and the shipping order.

Kind choice: for user/workspace automations (a script over workspace files or workspace.sqlite on a schedule, deterministic, no LLM) PREFER kind 'command' — a workspace job running a shell command in the workspace file area, armed immediately; put the script into the workspace file area (usually a project folder). Use kind 'code' (a workspace task file) when the body genuinely needs ctx.prisma or the platform tool surface (ctx.tools). Job runs are journaled — list_job_runs / get_job_run.

${REPO_RULES_NOTE}

Stay within your charter: scheduled tasks and what they directly need. For unrelated engineering on Balabash the user starts the engineer agent instead.

${OUTPUT_NOTE}

${WORKSPACE_STORAGE_NOTE}

End the thread when the task is done, cannot continue, or the user asks to stop; your report must state what was registered or changed, whether it was built, whether a restart was requested, and anything that remains. Stay with the assigned task: if the user clearly switches to an unrelated task or asks for the secretary, wrap up and end the thread.`;

export const agent = {
  name: 'scheduler',
  description:
    'Start a scheduler engineering thread: creates and maintains scheduled tasks that need engineering — ' +
    'workspace jobs (create_task kind "command": a script in the workspace file area run on a schedule) and ' +
    'code tasks (kind "code": a run(ctx) body in the workspace\'s tasks/ directory, live without a build; ' +
    'product bodies in the repository catalog). Simple reminder-style tasks need no agent: register them yourself with ' +
    'create_task kind "note"; an already-existing script can also be scheduled directly with create_task kind "command".',
  icon: '⏰',
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
  notification: 'normal',

  session: {
    instructions: SYSTEM_PROMPT,
    model: CLAUDE_MODEL,
    preset: 'full',
    cwd: REPO_ROOT,
  },
} satisfies AgentDeclaration;
