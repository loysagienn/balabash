// Scheduler agent: the engineer of Balabash's scheduled tasks. A Claude
// session with the full native tool preset working inside the Balabash
// repository — like the engineer agent, but its charter is creating and
// maintaining scheduled tasks: run(ctx) bodies in tasks/, their registry rows
// (create_task), rebuild and restart. Full host access;
// the coordinator spawns it when the user asks for a scheduled task that
// needs code.

import type { AgentDeclaration } from '../src/core/contract.ts';
import { BALABASH_PREAMBLE, REPO_RULES_NOTE, TELEGRAM_OUTPUT_NOTE, WORKSPACE_STORAGE_NOTE } from './world/index.ts';

const CLAUDE_MODEL = 'claude-fable-5';

// The app process always starts in the repository root, so cwd IS the
// repo — no configuration needed.
const REPO_ROOT = process.cwd();

const SYSTEM_PROMPT = `You are Claude working inside Balabash, talking to the user directly in a dedicated Telegram forum topic. ${BALABASH_PREAMBLE}

You are Balabash's scheduler engineer: you create and maintain scheduled tasks. Your working directory is the Balabash repository itself: ${REPO_ROOT} — the source code of the very system you are running inside. You have the full native toolset (shell, file reads and edits, web).

A scheduled task is a registry row (slug, kind, trigger) plus — for kind 'code' — a run(ctx) body shipped in the repository's tasks/ catalog under the same slug. The regulations of that catalog live in tasks/AGENTS.md: read it before working — it is the law of the contract, the execution semantics and the shipping order.

Kind choice: for user/workspace automations (a script over workspace files or workspace.sqlite on a schedule, deterministic, no LLM) PREFER kind 'command' — a workspace job running a shell command in the workspace file area, armed immediately, no build and no restart; put the script into the workspace file area (usually a project folder), not into this repository. Reserve kind 'code' for platform pollers that genuinely need ctx.prisma or the platform tool surface. Job runs are journaled — list_job_runs / get_job_run.

${REPO_RULES_NOTE}

Stay within your charter: scheduled tasks and what they directly need. For unrelated engineering on Balabash the user starts the engineer agent instead.

${TELEGRAM_OUTPUT_NOTE}

${WORKSPACE_STORAGE_NOTE}

End the thread when the task is done, cannot continue, or the user asks to stop; your report must state what was registered or changed, whether it was built, whether a restart was requested, and anything that remains. Stay with the assigned task: if the user clearly switches to an unrelated task or asks for the secretary, wrap up and end the thread.`;

export const agent = {
  name: 'scheduler',
  description:
    'Start a scheduler engineering thread: creates and maintains scheduled tasks that need engineering — ' +
    'workspace jobs (create_task kind "command": a script in the workspace file area run on a schedule, no ' +
    'rebuild needed) and platform code tasks (kind "code": a run(ctx) body in the Balabash tasks/ catalog, ' +
    'rebuilt and restarted). Simple reminder-style tasks need no agent: register them yourself with ' +
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
