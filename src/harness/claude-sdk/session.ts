// Low-level Claude Agent SDK session — port of v1 agents/lib/claude-session:
// a streaming input queue feeding query(), so the session stays open across
// turns and new user messages can be pushed while it runs. The public harness
// shape lives in sdk-session.ts; this module owns only the SDK mechanics.

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Query, SDKControlGetContextUsageResponse, SDKControlGetUsageResponse, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

export type ClaudeSessionOptions = NonNullable<Parameters<typeof query>[0]['options']>;

export type ClaudeSession = {
  // The SDK message stream; ends after close().
  messages: AsyncIterable<SDKMessage>;
  // Enqueue the next user message. Throws after close().
  push: (text: string) => void;
  // Interrupt the turn in flight (SDK control request); the session stays
  // open. Resolves when the CLI acknowledged; rejects when the session is
  // gone.
  interrupt: () => Promise<void>;
  // Context-window occupancy as the inner CLI computes it (the /context
  // report, structured). Rejects when the session is gone.
  getContextUsage: (opts?: { detail?: 'summary' | 'full' }) => Promise<SDKControlGetContextUsageResponse>;
  // The plan's rate-limit windows as the inner CLI reads them from the
  // claude.ai usage endpoint (the /usage report, structured; the transcript
  // scan skipped). The SDK marks the control experimental: a build without
  // it, or a CLI refusing it, rejects — the caller treats that as "no
  // measurement", never as a session failure.
  getUsage: () => Promise<SDKControlGetUsageResponse>;
  // End the input queue and close the underlying session. Idempotent.
  close: () => void;
};

type QueueWaiter = {
  resolve: (result: IteratorResult<SDKUserMessage>) => void;
};

function createUserMessage(text: string): SDKUserMessage {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: text,
    },
    parent_tool_use_id: null,
  };
}

function createMessageQueue(initialMessage: SDKUserMessage) {
  const messages: SDKUserMessage[] = [initialMessage];
  const waiters: QueueWaiter[] = [];
  let ended = false;

  const push = (message: SDKUserMessage) => {
    if (ended) {
      throw new Error('Claude session input is already closed');
    }

    const waiter = waiters.shift();

    if (waiter) {
      waiter.resolve({ value: message, done: false });
    } else {
      messages.push(message);
    }
  };

  const end = () => {
    if (ended) {
      return;
    }

    ended = true;

    for (const waiter of waiters.splice(0)) {
      waiter.resolve({ value: undefined, done: true });
    }
  };

  const iterable: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]() {
      return {
        next: async (): Promise<IteratorResult<SDKUserMessage>> => {
          const message = messages.shift();

          if (message) {
            return { value: message, done: false };
          }

          if (ended) {
            return { value: undefined, done: true };
          }

          return new Promise(resolve => {
            waiters.push({ resolve });
          });
        },
      };
    },
  };

  return { iterable, push, end };
}

export function startClaudeSession(initialText: string, options: ClaudeSessionOptions): ClaudeSession {
  const queue = createMessageQueue(createUserMessage(initialText));
  const session = query({
    prompt: queue.iterable,
    options,
  });
  let closed = false;

  return {
    messages: session,
    push: text => queue.push(createUserMessage(text)),
    interrupt: async () => {
      if (closed) {
        return;
      }

      await session.interrupt();
    },
    getContextUsage: async opts => {
      if (closed) {
        throw new Error('Claude session is closed');
      }

      return session.getContextUsage(opts);
    },
    getUsage: async () => {
      if (closed) {
        throw new Error('Claude session is closed');
      }

      const control = (session as Partial<Query>).usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;

      if (typeof control !== 'function') {
        throw new Error('this Claude Agent SDK has no usage control');
      }

      return control.call(session, { skipBehaviors: true });
    },
    close: () => {
      if (closed) {
        return;
      }

      closed = true;
      queue.end();
      session.close();
    },
  };
}
