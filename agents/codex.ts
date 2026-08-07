// Codex agent: a general-purpose OpenAI Codex session in its own thread. It
// keeps Codex's built-in tool set intact and adds the run's Balabash MCP bundle
// plus bridge-only lifecycle/file-delivery tools.

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

type CodexInput = {
  task: string;
  context: string | null;
};

const SYSTEM_PROMPT = `You are OpenAI Codex working inside Balabash, talking to the user directly in a dedicated Telegram forum topic.

The main Balabash assistant started this thread for a task. The first message carries the task and any context already known; everything after it comes from the user (the workspace may be shared — messages are prefixed with the speaker's name).

How your output reaches the user: every completed agent message is sent into the topic. Reply in the user's language. Use only the simple Markdown subset Telegram renders: **bold**, *italic*, \`code\`, fenced code blocks, links, blockquotes, simple lists. No tables or HTML. Never end a turn with empty final text.

Your normal Codex tools remain available. You also have Balabash MCP tools, which are loaded lazily. At the start of the session, search the full runtime tool catalog for mcp__balabash__* so they are available before you need them.

Special Balabash tools:
- send_file_to_user delivers a stored Balabash file into the topic.
- end_codex(summary) closes this thread and reports the result to the main assistant. Call it when the task is complete, cannot continue, or the user asks to stop. The summary must state what was done, the outcome, files or refs produced, and anything that remains. In the same turn, use your final text as a short handoff to the user.

Stay with the assigned task. If the user clearly switches to an unrelated task or asks for the main assistant, wrap up and call end_codex.`;

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseInput(input: unknown): CodexInput {
  if (!isObject(input) || typeof input.task !== 'string' || !input.task.trim()) {
    throw new Error('codex requires a non-empty task');
  }

  return {
    task: input.task.trim(),
    context: typeof input.context === 'string' && input.context.trim() ? input.context.trim() : null,
  };
}

function buildInitialMessage(input: CodexInput): string {
  return `Task from the main assistant: ${input.task}

Context from the main assistant:
${input.context ?? '(none — start from the task itself)'}

Start working on the task and keep the user informed in this topic.`;
}

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

function describeEvent(event: Event): string {
  return `[Balabash event]\ntype: ${event.type}\npayload: ${JSON.stringify(event.payload)}`;
}

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

    const endCodexTool: SdkBridgeTool = {
      name: 'end_codex',
      description:
        'End this Codex task and report back to the main assistant. Call it when the task is complete, cannot continue, or the user wants to stop.',
      inputSchema: {
        type: 'object',
        properties: {
          summary: {
            type: 'string',
            description: 'What was done, the outcome, files or refs produced, and anything that remains.',
          },
        },
        required: ['summary'],
        additionalProperties: false,
      },
      handler: async args => {
        const summary = typeof args.summary === 'string' ? args.summary.trim() : '';

        if (!summary) {
          throw new Error('end_codex requires a non-empty summary');
        }

        endSummary = summary;

        return 'accepted — finish this turn with a short handoff';
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
          info.contentType?.toLowerCase().startsWith('image/') ? { type: 'image', fileId } : { type: 'file', fileId },
        );

        await ctx.pushEvent('agent.message', { content: content as unknown as JsonValue[] } as JsonObject);

        return 'file sent';
      },
    };

    const session = ctx.harness.sdkSession({
      instructions: SYSTEM_PROMPT,
      initialMessage: buildInitialMessage(input),
      extraTools: [endCodexTool, sendFileTool],
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

        stop(settled ? undefined : new Error('Codex session ended before end_codex was called'));
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
