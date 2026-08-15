// Engineer agent: Balabash's own engineer. A Claude session with the full
// native tool preset (shell, file edits, web) working inside the Balabash
// repository on the host — the user directs it in a dedicated forum topic.
// Consent-gated (§7.4): only the coordinator spawns it, on an explicit user
// request; the repo path in the prompt is a convention — the real boundary is
// the unix user the process runs as. Fully declarative: the platform's
// session runner drives the lifecycle.

import type { AgentDeclaration } from '../src/core/contract.ts';
import { BALABASH_PREAMBLE, REPO_RULES_NOTE, TELEGRAM_OUTPUT_NOTE, WORKSPACE_STORAGE_NOTE } from './world/index.ts';

const CLAUDE_MODEL = 'claude-fable-5';

// The app process always starts in the repository root (§12), so cwd IS the
// repo — no configuration needed.
const REPO_ROOT = process.cwd();

const SYSTEM_PROMPT = `You are Claude working inside Balabash, talking to the user directly in a dedicated Telegram forum topic. ${BALABASH_PREAMBLE}

You are Balabash's own engineer. Your working directory is the Balabash repository itself: ${REPO_ROOT}. This is the source code of the very system you are running inside. You have the full native toolset (shell, file reads and edits, web) and may do whatever the task needs in this repository: explore, change code, run checks, use git. The user sets the tasks in this topic; when a task is open-ended, ask what they want rather than guessing.

${REPO_RULES_NOTE}

${TELEGRAM_OUTPUT_NOTE}

${WORKSPACE_STORAGE_NOTE}

End the thread when the task is done, cannot continue, or the user asks to stop; your report must state what was changed, whether it was built, whether a restart was requested, and anything that remains. Stay with the assigned task: if the user clearly switches to an unrelated task or asks for the secretary, wrap up and end the thread.`;

export const agent = {
  name: 'engineer',
  description:
    'Start an engineering thread working inside the Balabash repository itself — reading and changing ' +
    "Balabash's own source code with the full native toolset (shell, file edits) on the host. Use it for " +
    'self-extension: adding capabilities, fixing or inspecting Balabash. Consent-gated: start it ONLY when ' +
    'the user explicitly asks to work on Balabash itself, never on your own initiative.',
  icon: '🛠',
  sdk: 'claude',
  parameters: {
    type: 'object',
    properties: {
      task: {
        type: 'string',
        description: 'The concrete task on the Balabash codebase, as the user framed it.',
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
  consentTools: ['restart'],
  consent: true,
  notification: 'normal',

  session: {
    instructions: SYSTEM_PROMPT,
    model: CLAUDE_MODEL,
    preset: 'full',
    cwd: REPO_ROOT,
  },
} satisfies AgentDeclaration;
