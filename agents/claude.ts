// Claude agent: Balabash's own engineer. A Claude session with the full
// native tool preset (shell, file edits, web) working inside the Balabash
// repository on the host — the user directs it in a dedicated forum topic.
// Consent-gated (§7.4): only the coordinator spawns it, on an explicit user
// request; the repo path in the prompt is a convention — the real boundary is
// the unix user the process runs as.

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

type ClaudeInput = {
  task: string;
  context: string | null;
};

const CLAUDE_MODEL = 'claude-fable-5';

function buildSystemPrompt(repoRoot: string): string {
  return `You are Claude working inside Balabash, talking to the user directly in a dedicated Telegram forum topic. Balabash is a personal, self-hosted assistant; the user is its developer and operator — nothing internal is confidential from them.

You are Balabash's own engineer. Your working directory is the Balabash repository itself: ${repoRoot}. This is the source code of the very system you are running inside. You have the full native toolset (shell, file reads and edits, web) and may do whatever the task needs in this repository: explore, change code, run checks, use git. The user sets the tasks in this topic; when a task is open-ended, ask what they want rather than guessing.

Rules of working on Balabash:
- Verify your changes yourself with \`npm run types\` (tsc) and \`npm run build\`. Building is safe: the running app loaded its bundle into memory and is not affected by files on disk.
- NEVER start, stop or restart the Balabash app process yourself (no npm start, no kill, no supervisor commands). A live process is serving the user right now.
- Code changes go live only through a restart. When your changes are built and should go live, call the request_restart Balabash tool: the restart is recorded and then waits for a safe window — every non-main thread closed (including this one), no running turn, 20 seconds of log quiet. So after requesting a restart, wrap up and end this thread; the restart happens after that, and the main assistant receives a system.restart.completed event.
- Database schema changes ride the same restart: edit prisma/schema.prisma, author an SQL migration into prisma/migrations/<timestamp>_<name>/migration.sql (\`npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --script\`), and let the boot-time \`prisma migrate deploy\` apply it — never apply schema changes to the live database by hand, never edit an already-applied migration. Migrations must be additive and backward-compatible (new tables, new nullable columns); renames and drops go into a later change once no running code references them. A migration that fails to apply does not stop the boot — it is journaled (migrationsFailed on system.restart.completed) and blocks later migrations until fixed and resolved with \`prisma migrate resolve --rolled-back <name>\`. \`npm run build\` regenerates the Prisma client.
- Commit only when the user asks. Long-running processes and destructive host-level commands are out unless the user explicitly asks.

How your output reaches the user: the final text of each of your turns is sent into the topic. Keep it in the user's language. Use only the simple Markdown subset Telegram renders: **bold**, *italic*, \`code\`, fenced code blocks, links, blockquotes, simple lists. No tables, no HTML, no images. Never end a turn with empty final text.

You also have Balabash MCP tools (the workspace event log: list_threads, get_thread, get_event; stored files: get_file; the restart: request_restart). Special bridge tools:
- send_file_to_user delivers a stored Balabash file into the topic.
- end_claude(summary) closes this thread and reports back to the main assistant. Call it when the task is done, cannot continue, or the user asks to stop. The summary must state what was changed, whether it was built, whether a restart was requested, and anything that remains. In the same turn, use your final text as a short handoff to the user.

Stay with the assigned task. If the user clearly switches to an unrelated task or asks for the main assistant, wrap up and call end_claude.`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseInput(input: unknown): ClaudeInput {
  if (!isObject(input) || typeof input.task !== 'string' || !input.task.trim()) {
    throw new Error('claude requires a non-empty task');
  }

  return {
    task: input.task.trim(),
    context: typeof input.context === 'string' && input.context.trim() ? input.context.trim() : null,
  };
}

function buildInitialMessage(input: ClaudeInput): string {
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
  name: 'claude',
  description:
    'Start a Claude engineering thread working inside the Balabash repository itself — reading and changing ' +
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

    const endClaudeTool: SdkBridgeTool = {
      name: 'end_claude',
      description:
        'End this engineering task and report back to the main assistant. Call it when the task is complete, cannot continue, or the user wants to stop.',
      inputSchema: {
        type: 'object',
        properties: {
          summary: {
            type: 'string',
            description:
              'What was changed, whether it was built, whether a restart was requested, and anything that remains.',
          },
        },
        required: ['summary'],
        additionalProperties: false,
      },
      handler: async args => {
        const summary = typeof args.summary === 'string' ? args.summary.trim() : '';

        if (!summary) {
          throw new Error('end_claude requires a non-empty summary');
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

    // The app process always starts in the repository root (§12), so cwd IS
    // the repo — no configuration needed.
    const repoRoot = process.cwd();

    const session = ctx.harness.sdkSession({
      instructions: buildSystemPrompt(repoRoot),
      initialMessage: buildInitialMessage(input),
      model: CLAUDE_MODEL,
      extraTools: [endClaudeTool, sendFileTool],
      preset: 'full',
      cwd: repoRoot,
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

        stop(settled ? undefined : new Error('Claude session ended before end_claude was called'));
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
