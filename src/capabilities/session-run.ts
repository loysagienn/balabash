// The declarative session runner: turns an AgentDeclaration's `session` spec
// into an AgentRun. This is the platform half of "an agent is a declaration"
// — everything the four original session agents used to copy by hand lives
// here once: the SDK session lifecycle, rendering of incoming events into
// session messages, channel binding (forum topic vs headless parent
// dialogue), the standard base verbs (end_thread, send_file), abort handling
// and tool-catalog resyncs.

import type {
  AgentDeclaration,
  AgentRun,
  ContentBlock,
  Event,
  JsonObject,
  JsonValue,
  RunContext,
  SdkBridgeTool,
  SessionAgentSpec,
  ThreadSummary,
} from '../core/contract.ts';

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Incoming event rendering: how the log's events read inside the session.

// "Who speaks" prefix: the workspace is multi-voice.
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
      }${typeof meta.contentType === 'string' ? `, type=${meta.contentType}` : ''}]\nUse the get_file tool for its metadata and a download URL; fetch the URL when the contents are needed.`,
    );
  }

  return parts.join('\n');
}

// An incoming thread.message: text plus attached file references. From the
// parent it is the operator speaking (labeled in a topic thread, where the
// operator is distinct from the user; plain in a headless thread, where the
// operator's instructions are the only dialogue); from a spawned child it is
// the child's reply, labeled with the child's threadId.
function describeThreadMessage(
  event: Event,
  headless: boolean,
  childThreadIds: ReadonlySet<string>,
): string {
  const payload = isObject(event.payload) ? event.payload : {};
  const text = typeof payload.text === 'string' ? payload.text.trim() : '';
  const fileIds = Array.isArray(payload.fileIds)
    ? payload.fileIds.filter((id): id is string => typeof id === 'string' && Boolean(id))
    : [];

  if (event.threadId && childThreadIds.has(event.threadId)) {
    return [
      ...(text ? [`[Reply from child thread ${event.threadId}]\n${text}`] : []),
      ...fileIds.map(fileId => `[the child attached a file: fileId=${fileId}]`),
    ].join('\n');
  }

  return [
    ...(text ? [headless ? text : `[Message from your operator — not from the user]\n${text}`] : []),
    ...fileIds.map(fileId => `[the operator attached a file: fileId=${fileId}]`),
  ].join('\n');
}

// Events fanned into the run besides the dialogue: lifecycle of this thread's
// own children, redirected facts, domain events.
function describeEvent(event: Event): string {
  return `[Balabash event]\ntype: ${event.type}\npayload: ${JSON.stringify(event.payload)}`;
}

// ---------------------------------------------------------------------------
// The standard base verbs (§7.1 base kit): every session agent gets them.

type EndState = { summary: ThreadSummary | null };

function createEndThreadTool(end: EndState): SdkBridgeTool {
  return {
    name: 'end_thread',
    description:
      'End this thread and report back to your operator — the one who started it. Call it when the task ' +
      'is done, cannot continue, or you are asked to stop. In the same turn, finish with a short final text.',
    inputSchema: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description:
            'The report for your operator: the outcome, decisions, produced files or refs, anything that ' +
            'remains. It is the only compressed record this thread leaves behind.',
        },
        fileIds: {
          type: ['array', 'null'],
          items: { type: 'string' },
          description: 'Stored fileIds that belong with the report, or null.',
        },
      },
      required: ['summary', 'fileIds'],
      additionalProperties: false,
    },
    handler: async args => {
      const summary = typeof args.summary === 'string' ? args.summary.trim() : '';

      if (!summary) {
        throw new Error('end_thread requires a non-empty summary');
      }

      const fileIds = Array.isArray(args.fileIds)
        ? args.fileIds.filter((id): id is string => typeof id === 'string' && Boolean(id.trim()))
        : [];

      end.summary = { text: summary, ...(fileIds.length ? { fileIds } : {}) };

      return 'accepted — finish this turn with a short final text';
    },
  };
}

function createSendFileTool(ctx: RunContext, headless: boolean): SdkBridgeTool {
  return {
    name: 'send_file',
    description: headless
      ? 'Send a stored Balabash file to your operator, by fileId.'
      : 'Send a stored Balabash file into the topic as a document, by fileId.',
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
        throw new Error('send_file requires fileId');
      }

      const info = await ctx.files.getInfo(fileId);
      const caption = typeof args.caption === 'string' && args.caption.trim() ? args.caption.trim() : null;

      if (headless) {
        await ctx.sendToParent(caption ?? `[file] ${info.originalFilename ?? fileId}`, [fileId]);

        return 'file sent to the operator';
      }

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
}

// Child-operating verbs: granted when the declaration lists spawnable
// sub-agents. Spawning makes this agent the child's operator — it drives the
// child with send_to_thread and receives replies as thread messages.
function createChildTools(
  ctx: RunContext,
  allowedAgents: string[],
  childThreadIds: Set<string>,
): SdkBridgeTool[] {
  const spawnAgentTool: SdkBridgeTool = {
    name: 'spawn_agent',
    description:
      `Spawn a sub-agent in a child thread and become its operator. Allowed agents: ${allowedAgents.join(', ')}. ` +
      'The call returns the child threadId. The child works asynchronously: its replies arrive on their own as ' +
      'messages labeled with that threadId — end your turn and wait for them. Drive it step by step with ' +
      'send_to_thread, and cancel it with cancel_thread when it is no longer needed.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: `The agent to spawn: one of ${allowedAgents.join(', ')}.` },
        title: { type: 'string', description: 'Short human-readable title for the child thread.' },
        input: { type: 'object', description: "The spawn input matching the agent's input schema." },
      },
      required: ['agent', 'title', 'input'],
      additionalProperties: false,
    },
    handler: async args => {
      const agentName = typeof args.agent === 'string' ? args.agent.trim() : '';
      const title = typeof args.title === 'string' && args.title.trim() ? args.title.trim() : undefined;
      const input = isObject(args.input) ? (args.input as JsonObject) : {};

      if (!agentName) {
        throw new Error('spawn_agent requires agent');
      }

      const child = await ctx.spawn(agentName, input, title ? { title } : undefined);

      childThreadIds.add(child.threadId);

      return (
        `spawned — child threadId: ${child.threadId}; its replies arrive on their own as messages labeled ` +
        'with this id. End your turn and wait.'
      );
    },
  };

  const sendToThreadTool: SdkBridgeTool = {
    name: 'send_to_thread',
    description:
      'Send a message into a child thread you spawned — the way to drive the sub-agent: instructions, ' +
      'follow-ups, answers to its questions. Optionally attach stored files by fileId.',
    inputSchema: {
      type: 'object',
      properties: {
        threadId: { type: 'string', description: 'The child threadId returned by spawn_agent.' },
        text: { type: 'string', description: 'The message text delivered to the child agent.' },
        fileIds: {
          type: ['array', 'null'],
          items: { type: 'string' },
          description: 'Stored fileIds to attach, or null.',
        },
      },
      required: ['threadId', 'text', 'fileIds'],
      additionalProperties: false,
    },
    handler: async args => {
      const threadId = typeof args.threadId === 'string' ? args.threadId.trim() : '';
      const text = typeof args.text === 'string' ? args.text.trim() : '';
      const fileIds = Array.isArray(args.fileIds)
        ? args.fileIds.filter((id): id is string => typeof id === 'string' && Boolean(id.trim()))
        : [];

      if (!threadId || !text) {
        throw new Error('send_to_thread requires threadId and non-empty text');
      }

      await ctx.sendToChild(threadId, text, fileIds.length ? fileIds : undefined);

      return (
        "sent — the child's reply will arrive on its own as a new message in this session. " +
        'End your turn and wait for it.'
      );
    },
  };

  const cancelThreadTool: SdkBridgeTool = {
    name: 'cancel_thread',
    description:
      'Cancel a child thread you spawned — work that is no longer needed or a sub-agent stuck without progress.',
    inputSchema: {
      type: 'object',
      properties: {
        threadId: { type: 'string', description: 'The child threadId to cancel.' },
        reason: { type: ['string', 'null'], description: 'A concise reason, or null.' },
      },
      required: ['threadId', 'reason'],
      additionalProperties: false,
    },
    handler: async args => {
      const threadId = typeof args.threadId === 'string' ? args.threadId.trim() : '';

      if (!threadId) {
        throw new Error('cancel_thread requires threadId');
      }

      const reason = typeof args.reason === 'string' && args.reason.trim() ? args.reason.trim() : 'cancelled';

      await ctx.cancelChild(threadId, reason);

      return 'cancel requested';
    },
  };

  return [spawnAgentTool, sendToThreadTool, cancelThreadTool];
}

// ---------------------------------------------------------------------------

export function createSessionRun(
  declaration: AgentDeclaration,
  spec: SessionAgentSpec,
  input: JsonObject,
  ctx: RunContext,
): AgentRun {
  const headless = declaration.headless === true;
  const allowedAgents = declaration.agents ?? [];
  // Children spawned by this run: their replies are labeled by threadId in
  // the dialogue (a thread.message whose author is not the parent).
  const childThreadIds = new Set<string>();

  const end: EndState = { summary: null };
  let settled = false;
  let resolveFinished: () => void;
  let rejectFinished: (error: unknown) => void;

  const finished = new Promise<void>((resolve, reject) => {
    resolveFinished = resolve;
    rejectFinished = reject;
  });

  const session = ctx.harness.sdkSession({
    instructions: spec.instructions,
    initialMessage: spec.initialMessage(input),
    ...(spec.model ? { model: spec.model } : {}),
    ...(spec.effort ? { effort: spec.effort } : {}),
    ...(spec.preset ? { preset: spec.preset } : {}),
    ...(spec.cwd ? { cwd: spec.cwd } : {}),
    extraTools: [
      createEndThreadTool(end),
      createSendFileTool(ctx, headless),
      ...(allowedAgents.length ? createChildTools(ctx, allowedAgents, childThreadIds) : []),
    ],
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

  // External cancellation (/cancel, cancel_thread, cascade): the terminal is
  // already written; just shut the session down.
  ctx.signal.addEventListener('abort', () => stop(), { once: true });

  // The channel binding: where a turn's final text goes. A topic agent talks
  // to the user through agent.message; a headless agent answers its operator
  // with an addressed thread.message.
  const deliverTurnText = async (text: string) => {
    if (headless) {
      await ctx.sendToParent(text);

      return;
    }

    await ctx.pushEvent('agent.message', {
      content: [{ type: 'text', text }] as unknown as JsonValue[],
    } as JsonObject);
  };

  void (async () => {
    try {
      for await (const turn of session.turns) {
        if (settled) {
          return;
        }

        // On end_thread the summary carries the report to the operator; the
        // final text is the goodbye — meaningful in a topic (the user reads
        // it), redundant in a headless thread (the parent gets the summary).
        if (turn.text && !(headless && end.summary !== null)) {
          await deliverTurnText(turn.text);
        }

        if (end.summary !== null) {
          await ctx.complete(end.summary);
          stop();

          return;
        }
      }

      // The stream only ends after close(); reaching here without one is an
      // inner-session failure.
      stop(settled ? undefined : new Error(`${declaration.name} session ended before end_thread was called`));
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

      if (event.type === 'thread.message') {
        const text = describeThreadMessage(event, headless, childThreadIds);

        if (text) {
          session.push(text);
        }

        return;
      }

      // Any other delivered event may have changed the tool catalog (an
      // integration connected); refresh the bridge before the model reads
      // about it. When nothing changed the sync is a no-op diff; syncTools
      // never rejects.
      void session.syncTools().then(() => {
        if (!settled) {
          session.push(describeEvent(event));
        }
      });
    },
    finished,
  };
}
