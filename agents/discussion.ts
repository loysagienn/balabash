// Discussion agent (v2): an in-depth discussion of one topic in its own
// thread — the user talks to it directly in the thread's forum topic. Fully
// declarative: the platform's session runner drives the SDK session, the
// channel binding and the base verbs (end_thread, send_file).

import type { AgentDeclaration, JsonObject } from '../src/core/contract.ts';

const SYSTEM_PROMPT = `You are Balabash's discussion partner, talking to the user directly in a dedicated Telegram forum topic.

The main Balabash assistant started this thread for an in-depth discussion of one topic. The first message carries the topic and whatever context the assistant already had; everything after it comes from the user (the workspace may be shared — messages are prefixed with the speaker's name).

How your output reaches the user: the final text of each of your turns is sent into the topic as a message. Keep it conversational and in the user's language. Use only the simple Markdown subset Telegram renders: **bold**, *italic*, \`code\`, fenced code blocks, links, blockquotes, simple lists. No tables, no HTML, no images. Never end a turn with empty final text — every turn must reply to the user.

You have Balabash's tools: the workspace event log (list_threads, get_thread, get_thread_events, get_event) and stored files (get_file). Use them when they genuinely serve the discussion; this is a conversation, not a research pipeline.

Special tools:
- send_file delivers a stored Balabash file into the topic.
- end_thread(summary) closes this thread and reports back to the main assistant. Call it when the topic is closed or the user asks to stop. Write the summary for the main assistant: theses, decisions, positions, open threads — it is the only compressed record of this discussion. In the same turn, use your final text as a short goodbye to the user.

Stay on the discussion's topic. If the user clearly switches to unrelated tasks or asks for the main assistant, wrap up and call end_thread.`;

export const agent = {
  name: 'discussion',
  description:
    'Start a dedicated discussion thread for one substantial topic. Use it when the user wants to engage ' +
    'with a subject in depth — thinking through a decision, designing something, studying a subject, ' +
    'preparing for an interview, extended brainstorming — and the exchange is likely to span many messages ' +
    'and benefit from holding the full discussion context. The thread opens as a separate forum topic where ' +
    'the user talks to the discussion partner directly; it keeps the entire discussion in its own context ' +
    'window, has access to Balabash tools, and reports back with a summary when the topic is closed. ' +
    'Requires explicit user consent: propose starting a discussion and call this only after the user agrees.',
  icon: '💬',
  sdk: 'claude',
  parameters: {
    type: 'object',
    properties: {
      topic: {
        type: 'string',
        description: 'One focused subject for the discussion, as the user framed it.',
      },
      context: {
        type: ['string', 'null'],
        description:
          'Everything already established that the discussion should start from: the goal, constraints, ' +
          'positions already voiced, relevant fileIds or event seqs. Null when the topic starts fresh.',
      },
    },
    required: ['topic', 'context'],
    additionalProperties: false,
  },
  tools: 'all',
  notification: 'normal',

  session: {
    instructions: SYSTEM_PROMPT,
    model: 'claude-opus-5',
    initialMessage: (input: JsonObject) => `Discussion topic: ${typeof input.topic === 'string' ? input.topic.trim() : ''}

Context from the main assistant:
${typeof input.context === 'string' && input.context.trim() ? input.context.trim() : '(none — the topic starts fresh)'}

Open the discussion: greet the user briefly and engage with the topic.`,
  },
} satisfies AgentDeclaration;
