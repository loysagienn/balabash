// The manager role: one brief and one passport shared by every agent that
// plays the manager on a different backend (manager — Claude, codex — OpenAI
// Codex). An agent module may export only `agent` (validate-agent), so the
// shared parts live here; the agent modules import them instead of retelling
// them, and the two declarations cannot drift apart.

import path from 'node:path';
import {
  BALABASH_PREAMBLE,
  BLOCKED_PATH_NOTE,
  BROWSER_SUBAGENT_NOTE,
  OUTPUT_NOTE,
  PROJECTS_NOTE,
  REMOTE_AGENTS_NOTE,
  WORKBENCH_NOTE,
  WORKSPACE_STORAGE_NOTE,
} from '../world/index.ts';

// The vendored official Anthropic office skills (.claude/skills/{docx,pptx,xlsx},
// unchanged). The app process starts in the repository root, so the absolute
// path resolves from cwd. Named by path rather than through the Skill tool
// because the role runs on two backends: the Claude manager's Skill tool lists
// them (its cwd lies inside the repository, whose project settings load), the
// Codex manager has no Skill tool and reads the files.
const SKILLS_DIR = path.resolve('.claude', 'skills');

const OFFICE_SKILLS_NOTE =
  'Office files are a native craft here: Word (.docx), PowerPoint (.pptx) and Excel (.xlsx) documents you ' +
  'read, create and edit yourself, following the vendored official Anthropic skills — invoke the docx, pptx ' +
  `or xlsx skill if your Skill tool lists it, otherwise read ${SKILLS_DIR}/<docx|pptx|xlsx>/SKILL.md and ` +
  'follow it; the scripts live next to each SKILL.md. Host prerequisites (LibreOffice, pandoc, poppler, ' +
  'fonts, the python and node libraries, pptxgenjs and docx resolvable from the workbench) are ' +
  'provisioned. Render documents and slides to images and look at them before claiming how they look.';

export const MANAGER_INSTRUCTIONS = `You are Balabash's manager: take the user's tasks and get them done with the tools available. You talk to the user directly in a dedicated thread. ${BALABASH_PREAMBLE}

${BLOCKED_PATH_NOTE}

${OUTPUT_NOTE}

${WORKBENCH_NOTE}

${PROJECTS_NOTE}

${WORKSPACE_STORAGE_NOTE}

${OFFICE_SKILLS_NOTE}

${BROWSER_SUBAGENT_NOTE}

${REMOTE_AGENTS_NOTE}`;

// The tool passport of the manager role: the tool-server names it gets.
export const MANAGER_TOOLS = [
  'current_datetime',
  'events',
  'gmail',
  'http_get',
  'notion',
  'perplexity',
  'projects',
  'remote',
  'schedule',
  'storage',
  'storage_download_file',
  'workspace',
];

// Sub-agents the manager role may spawn.
export const MANAGER_AGENTS = ['browser'];
