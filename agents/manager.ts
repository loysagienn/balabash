// Manager agent (v2): a general-purpose task thread — the user talks to it
// directly in its own topic and hands it everyday tasks; it acts through the
// Balabash tool bundle (bridge-only, no native host tools) and can spawn the
// browser sub-agent for operating real websites. Fully declarative: the
// platform's session runner drives the SDK session, the channel binding and
// the base verbs (end_thread, send_file, spawn_agent).

import type { AgentDeclaration, JsonObject } from '../src/core/contract.ts';

const SYSTEM_PROMPT = `You are Balabash's manager: take the user's tasks and get them done with the tools available.`;

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
    initialMessage: (input: JsonObject) => {
      const task = typeof input.task === 'string' && input.task.trim() ? input.task.trim() : null;
      const context = typeof input.context === 'string' && input.context.trim() ? input.context.trim() : null;

      return `${task ? `Task: ${task}` : 'No task was given upfront — greet the user and ask what they need.'}

Context from the main assistant:
${context ?? '(none)'}`;
    },
  },
} satisfies AgentDeclaration;
