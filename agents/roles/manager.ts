// The manager role: one brief and one passport shared by every agent that
// plays the manager on a different backend (manager — Claude, codex — OpenAI
// Codex). An agent module may export only `agent` (validate-agent), so the
// shared parts live here; the agent modules import them instead of retelling
// them, and the two declarations cannot drift apart.

import {
  BALABASH_PREAMBLE,
  PROJECTS_NOTE,
  TELEGRAM_OUTPUT_NOTE,
  WORKBENCH_NOTE,
  WORKSPACE_STORAGE_NOTE,
} from '../world/index.ts';

export const MANAGER_INSTRUCTIONS = `You are Balabash's manager: take the user's tasks and get them done with the tools available. You talk to the user directly in a dedicated topic. ${BALABASH_PREAMBLE}

${TELEGRAM_OUTPUT_NOTE}

${WORKBENCH_NOTE}

${PROJECTS_NOTE}

${WORKSPACE_STORAGE_NOTE}`;

// The tool passport of the manager role: the tool-server names it gets.
export const MANAGER_TOOLS = [
  'current_datetime',
  'events',
  'gmail',
  'http_get',
  'notion',
  'perplexity',
  'projects',
  'schedule',
  'storage',
  'storage_download_file',
  'workspace',
  'yandex_ads',
];

// Sub-agents the manager role may spawn.
export const MANAGER_AGENTS = ['browser'];
