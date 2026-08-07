// Discussion agent (v2): an in-depth discussion of one topic in its own
// thread — the user talks to it directly in the thread's forum topic. The
// dialog runs in a long-lived Claude Agent SDK session (billed to the
// operator's subscription, with its own context management) obtained from
// ctx.harness; Balabash tools reach the session through the harness's MCP
// bridge. The final text of each session turn goes to the thread as an
// agent.message; the inner model ends the thread with the end_discussion
// bridge tool, whose summary becomes the thread's terminal summary.
//
// Only types cross the core boundary (§7.1): this module has no runtime
// imports from src/ — core behaviour is injected through ctx.

import type {
  AgentDeclaration,
  AgentRun,
  ContentBlock,
  Event,
  JsonObject,
  JsonValue,
  RunContext,
  SdkBridgeTool,
} from '../src/core/contract.ts';

type DiscussionInput = {
  topic: string;
  context: string | null;
};

const DISCUSSION_MODEL = 'claude-opus-5';

const SYSTEM_PROMPT = `You are Balabash's discussion partner, talking to the user directly in a dedicated Telegram forum topic.

The main Balabash assistant started this thread for an in-depth discussion of one topic. The first message carries the topic and whatever context the assistant already had; everything after it comes from the user (the workspace may be shared — messages are prefixed with the speaker's name).

How your output reaches the user: the final text of each of your turns is sent into the topic as a message. Keep it conversational and in the user's language. Use only the simple Markdown subset Telegram renders: **bold**, *italic*, \`code\`, fenced code blocks, links, blockquotes, simple lists. No tables, no HTML, no images. Never end a turn with empty final text — every turn must reply to the user.

You have Balabash's tools: the workspace event log (list_threads, get_thread, get_event) and stored files (get_file). Use them when they genuinely serve the discussion; this is a conversation, not a research pipeline.

Special tools:
- send_file_to_user delivers a stored Balabash file into the topic.
- end_discussion(summary) closes this thread and reports back to the main assistant. Call it when the topic is closed or the user asks to stop. Write the summary for the main assistant: theses, decisions, positions, open threads — it is the only compressed record of this discussion. In the same turn, use your final text as a short goodbye to the user.

Stay on the discussion's topic. If the user clearly switches to unrelated tasks or asks for the main assistant, wrap up and call end_discussion.`;

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseInput(input: unknown): DiscussionInput {
  if (!isObject(input) || typeof input.topic !== 'string' || !input.topic.trim()) {
    throw new Error('discussion requires a non-empty topic');
  }

  return {
    topic: input.topic.trim(),
    context: typeof input.context === 'string' && input.context.trim() ? input.context.trim() : null,
  };
}

function buildInitialMessage(input: DiscussionInput): string {
  return `Discussion topic: ${input.topic}

Context from the main assistant:
${input.context ?? '(none — the topic starts fresh)'}

Open the discussion: greet the user briefly and engage with the topic.`;
}

// "Who speaks" prefix for the inner session: the workspace is multi-voice.
function speakerOf(payload: Record<string, unknown>): string | null {
  const identity = isObject(payload.identity) ? payload.identity : {};
  const name = [identity.firstName, identity.lastName]
    .filter((part): part is string => typeof part === 'string' && Boolean(part.trim()))
    .join(' ');
  const username = typeof identity.username === 'string' && identity.username ? `@${identity.username}` : null;

  if (name && username) {
    return `${name} (${username})`;
  }

  return name || username;
}

function describeUserMessage(payload: Record<string, unknown>): string {
  const speaker = speakerOf(payload);
  const text = typeof payload.text === 'string' ? payload.text : '';
  const files = Array.isArray(payload.files) ? payload.files : [];
  const parts: string[] = [];

  if (text) {
    parts.push(speaker ? `${speaker}: ${text}` : text);
  }

  for (const file of files) {
    const meta = isObject(file) ? file : {};

    parts.push(
      `[the user sent a file: fileId=${typeof meta.fileId === 'string' ? meta.fileId : 'unknown'}${
        typeof meta.originalFilename === 'string' ? `, name=${meta.originalFilename}` : ''
      }${typeof meta.contentType === 'string' ? `, type=${meta.contentType}` : ''}]\nUse the get_file tool to load its contents when needed.`,
    );
  }

  return parts.join('\n');
}

// Events fanned into the run besides the conversation: lifecycle of this
// thread's own children, redirected facts, future domain events.
function describeEvent(event: Event): string {
  return `[Balabash event]\ntype: ${event.type}\npayload: ${JSON.stringify(event.payload)}`;
}

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

  run(rawInput: unknown, ctx: RunContext): AgentRun {
    const input = parseInput(rawInput);

    let endSummary: string | null = null;
    let settled = false;
    let resolveFinished: () => void;
    let rejectFinished: (error: unknown) => void;

    const finished = new Promise<void>((resolve, reject) => {
      resolveFinished = resolve;
      rejectFinished = reject;
    });

    const endDiscussionTool: SdkBridgeTool = {
      name: 'end_discussion',
      description:
        'End the discussion and hand the conversation back to the main assistant. ' +
        'Call it when the topic is exhausted or the user wants to wrap up.',
      inputSchema: {
        type: 'object',
        properties: {
          summary: {
            type: 'string',
            description:
              'The record of this discussion for the main assistant: theses, decisions made, ' +
              'positions taken, open threads. It is the only compressed trace the discussion leaves.',
          },
        },
        required: ['summary'],
        additionalProperties: false,
      },
      handler: async args => {
        const summary = typeof args.summary === 'string' ? args.summary.trim() : '';

        if (!summary) {
          throw new Error('end_discussion requires a non-empty summary');
        }

        endSummary = summary;

        return 'accepted — finish this turn with a short goodbye';
      },
    };

    const sendFileTool: SdkBridgeTool = {
      name: 'send_file_to_user',
      description: 'Send a stored Balabash file into the topic as a document, by fileId.',
      inputSchema: {
        type: 'object',
        properties: {
          fileId: { type: 'string', description: 'The Balabash file ID to send.' },
          caption: { type: ['string', 'null'], description: 'Optional short plain-text caption.' },
        },
        required: ['fileId', 'caption'],
        additionalProperties: false,
      },
      handler: async args => {
        const fileId = typeof args.fileId === 'string' ? args.fileId.trim() : '';

        if (!fileId) {
          throw new Error('send_file_to_user requires fileId');
        }

        const info = await ctx.files.getInfo(fileId);
        const caption = typeof args.caption === 'string' && args.caption.trim() ? args.caption.trim() : null;
        const content: ContentBlock[] = [];

        if (caption) {
          content.push({ type: 'text', text: caption });
        }

        content.push(
          info.contentType?.toLowerCase().startsWith('image/')
            ? { type: 'image', fileId }
            : { type: 'file', fileId },
        );

        await ctx.pushEvent('agent.message', { content: content as unknown as JsonValue[] } as JsonObject);

        return 'file sent';
      },
    };

    const session = ctx.harness.sdkSession({
      instructions: SYSTEM_PROMPT,
      initialMessage: buildInitialMessage(input),
      model: DISCUSSION_MODEL,
      extraTools: [endDiscussionTool, sendFileTool],
    });

    const stop = (error?: unknown) => {
      if (settled) {
        return;
      }

      settled = true;
      session.close();

      if (error === undefined) {
        resolveFinished();
      } else {
        rejectFinished(error);
      }
    };

    // External cancellation (/cancel, cancel_thread, cascade): the terminal
    // is already written; just shut the session down.
    ctx.signal.addEventListener('abort', () => stop(), { once: true });

    void (async () => {
      try {
        for await (const turn of session.turns) {
          if (settled) {
            return;
          }

          if (turn.text) {
            await ctx.pushEvent('agent.message', {
              content: [{ type: 'text', text: turn.text }] as unknown as JsonValue[],
            } as JsonObject);
          }

          if (endSummary !== null) {
            await ctx.complete({ text: endSummary });
            stop();

            return;
          }
        }

        // The stream only ends after close(); reaching here without one is
        // an inner-session failure.
        stop(settled ? undefined : new Error('Discussion session ended before end_discussion was called'));
      } catch (error) {
        stop(error);
      }
    })();

    return {
      accept: (event: Event) => {
        if (settled) {
          return;
        }

        const payload = isObject(event.payload) ? event.payload : {};

        if (event.type === 'user.message') {
          const text = describeUserMessage(payload);

          if (text) {
            session.push(text);
          }

          return;
        }

        // Any other delivered event may have changed the tool catalog (an
        // integration connected — stage 4); refresh the bridge before the
        // model reads about it. When nothing changed the sync is a no-op
        // diff; syncTools never rejects.
        void session.syncTools().then(() => {
          if (!settled) {
            session.push(describeEvent(event));
          }
        });
      },
      finished,
    };
  },
} satisfies AgentDeclaration;
