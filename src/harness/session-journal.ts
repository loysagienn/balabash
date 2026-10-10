// The session journal writer: session.* events of a thread's inner SDK
// session, appended as the harness observed them. The harness journals map
// the SDK frames to entries (claude-sdk/session-journal.ts,
// codex-sdk/session-journal.ts; the payload forms are typed in
// src/core/event-types.ts) — this module owns the writing. Observational: a
// failed append is logged, never thrown into the session. Frames arrive
// synchronously while appends are async, so each thread writes through its
// own chain and the log keeps the order the harness saw. The thread's
// identity (workspace, agent) is read once per thread into a small bounded
// cache — the row exists before its session starts.
//
// The journal carries no bytes: sanitizeToolResult strips the binary blocks
// of a tool result (the rule both journals apply before writing).

import { appendEvent } from '../core/append.ts';
import type { JsonObject, JsonValue } from '../core/contract.ts';
import type { AppendInput } from '../core/envelope.ts';
import type { EventPayloads, SessionEventType } from '../core/event-types.ts';
import { getThread } from '../core/threads.ts';

// An entry is a session.* event in its typed payload form — a journal that
// writes a field the contract does not declare fails `npm run types`.
export type JournalEntry = { [T in SessionEventType]: { type: T; payload: EventPayloads[T] } }[SessionEventType];

// Entries, or a producer that yields them when its turn in the chain comes
// (a measurement taken only after the frames before it are written).
export type JournalInput = JournalEntry[] | (() => Promise<JournalEntry[]>);

export type JournalIdentity = { userId: string; agentName: string };

export type JournalWriterDeps = {
  append?: (input: AppendInput) => Promise<unknown>;
  identityOf?: (threadId: string) => Promise<JournalIdentity | null>;
  identityCacheSize?: number;
};

export type JournalWriter = {
  // Queues the input behind everything already queued for the thread.
  // Resolves when written (or given up on); never rejects. The value tells
  // which: true — every entry is in the log; false — at least one was
  // dropped (unknown thread, failed producer, failed append), for a writer
  // whose entry stands for a state it must see written (the coordinator's
  // session.state); the SDK journals ignore it.
  write(threadId: string, input: JournalInput): Promise<boolean>;
};

const IDENTITY_CACHE_SIZE = 64;

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

// The content of a tool result as the model saw it, minus bytes: text
// stays; an image, document or audio block keeps its type and media type
// and nothing else; an embedded resource keeps its uri. Covers both block
// dialects a journal meets — the Anthropic one (`source.media_type`,
// `source.data`) and MCP's (`mimeType`, `data` / `resource.blob`).
export function sanitizeToolResult(content: unknown): JsonValue {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return content === undefined ? '' : (content as JsonValue);
  }

  return content.map((block): JsonValue => {
    const view = asObject(block);
    const { type } = view;

    if (type === 'text') {
      return { type: 'text', text: typeof view.text === 'string' ? view.text : '' };
    }

    if (type === 'image' || type === 'document' || type === 'audio') {
      const mediaType = asObject(view.source).media_type ?? view.mimeType;

      return { type, omitted: true, ...(typeof mediaType === 'string' ? { mediaType } : {}) };
    }

    if (type === 'resource') {
      const resource = asObject(view.resource);

      if (typeof resource.blob === 'string') {
        return {
          type,
          omitted: true,
          ...(typeof resource.uri === 'string' ? { uri: resource.uri } : {}),
          ...(typeof resource.mimeType === 'string' ? { mediaType: resource.mimeType } : {}),
        };
      }
    }

    return block as JsonValue;
  });
}

async function readIdentity(threadId: string): Promise<JournalIdentity | null> {
  const thread = await getThread(threadId);

  return thread ? { userId: thread.userId, agentName: thread.agent } : null;
}

export function createJournalWriter(deps: JournalWriterDeps = {}): JournalWriter {
  const append = deps.append ?? appendEvent;
  const identityOf = deps.identityOf ?? readIdentity;
  const cacheSize = deps.identityCacheSize ?? IDENTITY_CACHE_SIZE;
  const identities = new Map<string, Promise<JournalIdentity | null>>();
  const chains = new Map<string, Promise<boolean>>();

  const identity = (threadId: string): Promise<JournalIdentity | null> => {
    const known = identities.get(threadId);

    if (known) {
      return known;
    }

    const lookup = identityOf(threadId).catch((error: unknown) => {
      console.error(`[session-journal] thread lookup failed thread=${threadId}:`, error);

      return null;
    });

    if (identities.size >= cacheSize) {
      const oldest = identities.keys().next().value;

      if (oldest !== undefined) {
        identities.delete(oldest);
      }
    }

    identities.set(threadId, lookup);

    // A miss is not remembered: the next burst looks again.
    void lookup.then(found => {
      if (!found && identities.get(threadId) === lookup) {
        identities.delete(threadId);
      }
    });

    return lookup;
  };

  const flush = async (threadId: string, input: JournalInput): Promise<boolean> => {
    const who = await identity(threadId);

    if (!who) {
      console.error(`[session-journal] thread ${threadId} is unknown; entries dropped`);

      return false;
    }

    let entries: JournalEntry[];

    try {
      entries = typeof input === 'function' ? await input() : input;
    } catch (error) {
      console.error(`[session-journal] producer failed thread=${threadId}:`, error);

      return false;
    }

    let written = true;

    for (const entry of entries) {
      try {
        await append({
          type: entry.type,
          actor: 'agent',
          agentName: who.agentName,
          userId: who.userId,
          threadId,
          payload: entry.payload as JsonObject,
        });
      } catch (error) {
        console.error(`[session-journal] append failed thread=${threadId} type=${entry.type}:`, error);
        written = false;
      }
    }

    return written;
  };

  return {
    write(threadId, input) {
      const previous = chains.get(threadId) ?? Promise.resolve(true);
      const next = previous.then(() => flush(threadId, input));

      chains.set(threadId, next);

      return next.finally(() => {
        if (chains.get(threadId) === next) {
          chains.delete(threadId);
        }
      });
    },
  };
}
