// Manager agent: a general-purpose task thread — the user talks to it
// directly in its own topic and hands it everyday tasks; it acts through the
// Balabash tool bundle plus the full native tool preset working on the
// per-user workbench (the workspace file area itself is its cwd, like the
// power_point agent), and can spawn the browser sub-agent for operating real
// websites. Fully declarative: the platform's session runner drives the SDK
// session, the channel binding and the base verbs (end_thread, send_file,
// spawn_agent).

import path from 'node:path';
import type { AgentDeclaration, JsonObject } from '../src/core/contract.ts';
import { WORKSPACE_STORAGE_NOTE } from './shared.ts';

// The app process always starts in the repository root (§12), so the
// workspace file area resolves from cwd — same base as tools/workspace.ts.
const WORKSPACE_ROOT = path.resolve('data', 'workspace');

const SYSTEM_PROMPT = `You are Balabash's manager: take the user's tasks and get them done with the tools available.

Your working directory is the user's workspace file area — your workbench. Work inside it; do not touch the Balabash repository or anything else on the host.
Path map: \`./x\` for your native tools is the same file as \`x\` for the workspace_* tools — both address paths from the workbench root.

You have a persistent data workbench, shared across all your sessions for this user:
- data_query — a workspace SQLite database (tables = datasets). Any SQL; inspect what exists via sqlite_master. SELECT results are capped, so query narrow slices or aggregates, never whole tables.
- run_script — Python or Node scripts (stdlib only) running in the workspace file area; the same database is at the WORKSPACE_DB env path. Use scripts for anything mechanical over data: downloads with pagination, parsing, bulk transforms. The iron rule: data goes to tables and files, stdout carries only a short summary — never funnel datasets through your context.
- workspace_write_file / workspace_read_file / workspace_get_file / workspace_list_files / workspace_delete_file — the workspace file area. Keep a sane structure: group files into per-task directories, save reusable scripts under scripts/. Always give scripts and long-lived files a title and description (for scripts include the accepted argv) — listings show these, and that is how future sessions discover what exists. Before writing a new script, check workspace_list_files for an existing one. Large inputs are passed to scripts as files, not argv.

${WORKSPACE_STORAGE_NOTE}`;

export const agent = {
  name: 'manager',
  description:
    'Start a manager thread — a general-purpose assistant that takes on the user\'s tasks and sees them ' +
    'through using the connected integrations, and can operate a real browser via a sub-agent when a task ' +
    'requires it. The thread opens as a separate topic where the user talks to the manager directly; a task ' +
    'may be given upfront or the thread may start open-ended, with the user handing tasks in the topic. ' +
    'Start it when the user asks for the manager or hands over a task of this kind.',
  icon: '🎩',
  sdk: 'claude',
  parameters: {
    type: 'object',
    properties: {
      task: {
        type: ['string', 'null'],
        description: 'The task to perform, as the user framed it — or null when the thread starts open-ended.',
      },
      context: {
        type: ['string', 'null'],
        description:
          'Everything already known that the work should start from: goals, constraints, decisions, fileIds ' +
          'or event refs. Null when no extra context is needed.',
      },
    },
    required: ['task', 'context'],
    additionalProperties: false,
  },
  tools: 'all',
  agents: ['browser'],
  notification: 'normal',

  session: {
    instructions: SYSTEM_PROMPT,
    model: 'claude-opus-5',
    preset: 'full',
    cwd: (userId: string) => path.join(WORKSPACE_ROOT, userId, 'files'),
    initialMessage: (input: JsonObject) => {
      const task = typeof input.task === 'string' && input.task.trim() ? input.task.trim() : null;
      const context = typeof input.context === 'string' && input.context.trim() ? input.context.trim() : null;

      return `${task ? `Task: ${task}` : 'No task was given upfront — greet the user and ask what they need.'}

Context from the secretary:
${context ?? '(none)'}`;
    },
  },
} satisfies AgentDeclaration;
