// Codex agent: a general-purpose OpenAI Codex session in its own thread. It
// keeps Codex's built-in tool set intact and adds the run's Balabash MCP
// bundle plus the standard base verbs (end_thread, send_file). Fully
// declarative: the platform's session runner drives the lifecycle.

import type { AgentDeclaration } from '../src/core/contract.ts';
import { BALABASH_PREAMBLE, PROJECTS_NOTE, TELEGRAM_OUTPUT_NOTE, THREAD_DIALOGUE_NOTE, WORKSPACE_STORAGE_NOTE } from './world/index.ts';

const SYSTEM_PROMPT = `You are OpenAI Codex working inside Balabash, talking to the user directly in a dedicated Telegram forum topic. ${BALABASH_PREAMBLE}

${THREAD_DIALOGUE_NOTE}

${TELEGRAM_OUTPUT_NOTE}

Your normal Codex tools remain available. The Balabash tools are loaded lazily in your environment: at the start of the session, search the full runtime tool catalog for mcp__balabash__* so they are available before you need them.

${WORKSPACE_STORAGE_NOTE}

${PROJECTS_NOTE}

End the thread when the task is complete, cannot continue, or the user asks to stop; your report must state what was done, the outcome, files or refs produced, and anything that remains. Stay with the assigned task: if the user clearly switches to an unrelated task or asks for the secretary, wrap up and end the thread.`;

export const agent = {
  name: 'codex',
  description:
    'Start a dedicated OpenAI Codex thread for a substantial task that benefits from an autonomous agent, ' +
    'its built-in local workspace tools, or an extended multi-turn execution context. The user talks to Codex ' +
    'directly in a separate forum topic; Codex also receives the full Balabash tool bundle and reports a summary ' +
    'back when the task ends.',
  icon: '🤖',
  sdk: 'codex',
  parameters: {
    type: 'object',
    properties: {
      task: {
        type: 'string',
        description: 'The concrete task for Codex to perform.',
      },
      context: {
        type: ['string', 'null'],
        description:
          'Everything already known that Codex should start from: goals, constraints, decisions, fileIds or event refs. Null when no extra context is needed.',
      },
    },
    required: ['task', 'context'],
    additionalProperties: false,
  },
  tools: 'all',
  notification: 'normal',

  session: {
    instructions: SYSTEM_PROMPT,
  },
} satisfies AgentDeclaration;
