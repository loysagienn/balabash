// Low-level Claude Agent SDK session — port of v1 agents/lib/claude-session:
// a streaming input queue feeding query(), so the session stays open across
// turns and new user messages can be pushed while it runs. The public harness
// shape lives in sdk-session.ts; this module owns only the SDK mechanics.

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

export type ClaudeSessionOptions = NonNullable<Parameters<typeof query>[0]['options']>;

export type ClaudeSession = {
  // The SDK message stream; ends after close().
  messages: AsyncIterable<SDKMessage>;
  // Enqueue the next user message. Throws after close().
  push: (text: string) => void;
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
