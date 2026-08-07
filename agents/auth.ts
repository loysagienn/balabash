// Auth agent (§10): connecting integrations in its own thread. The
// coordinator spawns it whenever an integration must be connected,
// re-authorized or provisioned; the user talks to it directly in the thread's
// forum topic. It is the only agent bundled with the consent 'auth' tool
// server (§7.4): one-time links for per-user OAuth, manual OAuth clients and
// installation secrets. Secret values never pass through this agent — links
// lead to web forms, values go out-of-band, and the outcomes arrive back as
// thread-addressed connection.* / *.provisioned events.
//
// Only types cross the core boundary (§7.1): this module has no runtime
// imports from src/ — core behaviour is injected through ctx.

import type {
  AgentDeclaration,
  AgentRun,
  Event,
  JsonObject,
  JsonValue,
  RunContext,
  SdkBridgeTool,
} from '../src/core/contract.ts';

type AuthInput = {
  task: string;
};

const AUTH_MODEL = 'claude-opus-5';

const SYSTEM_PROMPT = `You are Balabash's integration assistant, talking to the user directly in a dedicated Telegram forum topic.

The main Balabash assistant started this thread to get an integration connected, re-authorized, or provisioned with credentials. The first message carries the task; everything after it comes from the user (the workspace may be shared — messages are prefixed with the speaker's name).

How your output reaches the user: the final text of each of your turns is sent into the topic as a message. Keep it short, clear and in the user's language. Use only the simple Markdown subset Telegram renders: **bold**, *italic*, \`code\`, links, simple lists. Never end a turn with empty final text.

Your flow tools issue one-time links (valid 15 minutes):
- request_authorization — the user authorizes their own account of an integration via OAuth;
- request_oauth_client_credentials — the operator stores an installation-level OAuth client (needed once per integration without Dynamic Client Registration, before the first authorization);
- request_external_server_credentials — the operator stores installation secrets (API keys) for a global server.
Each tool's description lists the integrations it currently applies to and their status — read them carefully to pick the right order (an OAuth client before the first authorization, for example). Paste the returned link into your reply as a plain URL.

Credential values NEVER pass through you or this chat: links lead to secure web forms. Never ask the user to paste secrets, tokens or passwords into the chat; if they try, stop them and point back to the form.

Outcomes arrive into this thread as [Balabash event] messages: connection.completed / connection.failed after an authorization, oauth_client.provisioned / secrets.provisioned after a form. React to them: confirm success, explain a failure and issue a fresh link when it makes sense. Links expire after 15 minutes — reissue on request.

An integration task usually chains several steps — e.g. an installation OAuth client first, then the user's authorization. After an intermediate outcome, continue with the next step in this same thread right away (issue the next link without waiting to be asked); call end_auth only when the whole task is done, has failed for good, or the user stops.

You also have the workspace pull tools (list_threads, get_thread, get_event, get_file) if context is needed.

Call end_auth(summary) when the task is done or the user wants to stop. The summary reports the outcome to the main assistant: what got connected or provisioned, what failed, what remains. In the same turn, use your final text as a short goodbye.`;

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseInput(input: unknown): AuthInput {
  if (!isObject(input) || typeof input.task !== 'string' || !input.task.trim()) {
    throw new Error('auth requires a non-empty task');
  }

  return { task: input.task.trim() };
}

function buildInitialMessage(input: AuthInput): string {
  return `Integration task from the main assistant:
${input.task}

Start: check your tools' descriptions for the integrations they currently list, explain the next step to the user briefly, and issue the right link.`;
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

  return text ? (speaker ? `${speaker}: ${text}` : text) : '';
}

// Integration outcomes and any other addressed facts, verbatim for the model.
function describeEvent(event: Event): string {
  return `[Balabash event]\ntype: ${event.type}\npayload: ${JSON.stringify(event.payload)}`;
}

export const agent = {
  name: 'auth',
  description:
    'Connect, re-authorize or provision an external integration. Start it whenever the user wants to connect ' +
    'an integration (their own account via OAuth, e.g. Gmail), an integration reports expired authorization, ' +
    'or a server needs installation credentials (API keys) or an installation OAuth client. The thread opens ' +
    'as a separate forum topic where the auth assistant walks the user through one-time secure links; ' +
    'credential values never pass through the chat. It reports back with a summary of what got connected.',
  icon: '🔑',
  sdk: 'claude',
  parameters: {
    type: 'object',
    properties: {
      task: {
        type: 'string',
        description:
          'What must be connected or provisioned and why, as concretely as known: the integration name, ' +
          'whether it is a first connection or a re-authorization, and any relevant context from the user.',
      },
    },
    required: ['task'],
    additionalProperties: false,
  },
  tools: ['auth'],
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

    const endAuthTool: SdkBridgeTool = {
      name: 'end_auth',
      description:
        'End the integration task and report back to the main assistant. ' +
        'Call it when the task is done, failed for good, or the user wants to stop.',
      inputSchema: {
        type: 'object',
        properties: {
          summary: {
            type: 'string',
            description:
              'The outcome for the main assistant: what got connected or provisioned, what failed and why, ' +
              'what remains to be done.',
          },
        },
        required: ['summary'],
        additionalProperties: false,
      },
      handler: async args => {
        const summary = typeof args.summary === 'string' ? args.summary.trim() : '';

        if (!summary) {
          throw new Error('end_auth requires a non-empty summary');
        }

        endSummary = summary;

        return 'accepted — finish this turn with a short goodbye';
      },
    };

    const session = ctx.harness.sdkSession({
      instructions: SYSTEM_PROMPT,
      initialMessage: buildInitialMessage(input),
      model: AUTH_MODEL,
      extraTools: [endAuthTool],
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

        stop(settled ? undefined : new Error('Auth session ended before end_auth was called'));
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

        // Integration outcomes change the auth tools' statuses (and possibly
        // the wider catalog); refresh the bridge before the model reads the
        // event. syncTools never rejects.
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
