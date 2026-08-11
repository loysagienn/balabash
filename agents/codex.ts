// Codex agent: a general-purpose OpenAI Codex session in its own thread. It
// keeps Codex's built-in tool set intact and adds the run's Balabash MCP
// bundle plus the standard base verbs (end_thread, send_file). Fully
// declarative: the platform's session runner drives the lifecycle.

import type { AgentDeclaration, JsonObject } from '../src/core/contract.ts';

const SYSTEM_PROMPT = `You are OpenAI Codex working inside Balabash, talking to the user directly in a dedicated Telegram forum topic.

The main Balabash assistant started this thread for a task. The first message carries the task and any context already known; everything after it comes from the user (the workspace may be shared — messages are prefixed with the speaker's name).

How your output reaches the user: every completed agent message is sent into the topic. Reply in the user's language. Use only the simple Markdown subset Telegram renders: **bold**, *italic*, \`code\`, fenced code blocks, links, blockquotes, simple lists. No tables or HTML. Never end a turn with empty final text.

Your normal Codex tools remain available. You also have Balabash MCP tools, which are loaded lazily. At the start of the session, search the full runtime tool catalog for mcp__balabash__* so they are available before you need them.

Special Balabash tools:
- send_file delivers a stored Balabash file into the topic.
- end_thread(title, description, summary) closes this thread and reports the result to the main assistant. Call it when the task is complete, cannot continue, or the user asks to stop. The summary must state what was done, the outcome, files or refs produced, and anything that remains. The title (2–5 words, naming the work, never the agent) becomes the thread's final name; the description (~300 chars) tells a reader scanning thread lists what was worked on and how it ended. In the same turn, use your final text as a short handoff to the user.

Stay with the assigned task. If the user clearly switches to an unrelated task or asks for the main assistant, wrap up and call end_thread.`;

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
    initialMessage: (input: JsonObject) => `Task from the main assistant: ${typeof input.task === 'string' ? input.task.trim() : ''}

Context from the main assistant:
${typeof input.context === 'string' && input.context.trim() ? input.context.trim() : '(none — start from the task itself)'}

Start working on the task and keep the user informed in this topic.`,
  },
} satisfies AgentDeclaration;
