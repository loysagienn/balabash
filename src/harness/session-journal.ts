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

import { appendEvent } from '../core/append.ts';
import type { JsonObject } from '../core/contract.ts';
import type { AppendInput } from '../core/envelope.ts';
import { getThread } from '../core/threads.ts';

export type JournalEntry = { type: `session.${string}`; payload: JsonObject };

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
  // Resolves when written (or given up on); never rejects.
  write(threadId: string, input: JournalInput): Promise<void>;
};

const IDENTITY_CACHE_SIZE = 64;

async function readIdentity(threadId: string): Promise<JournalIdentity | null> {
  const thread = await getThread(threadId);

  return thread ? { userId: thread.userId, agentName: thread.agent } : null;
}

export function createJournalWriter(deps: JournalWriterDeps = {}): JournalWriter {
  const append = deps.append ?? appendEvent;
  const identityOf = deps.identityOf ?? readIdentity;
  const cacheSize = deps.identityCacheSize ?? IDENTITY_CACHE_SIZE;
  const identities = new Map<string, Promise<JournalIdentity | null>>();
  const chains = new Map<string, Promise<void>>();

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

  const flush = async (threadId: string, input: JournalInput): Promise<void> => {
    const who = await identity(threadId);

    if (!who) {
      console.error(`[session-journal] thread ${threadId} is unknown; entries dropped`);

      return;
    }

    let entries: JournalEntry[];

    try {
      entries = typeof input === 'function' ? await input() : input;
    } catch (error) {
      console.error(`[session-journal] producer failed thread=${threadId}:`, error);

      return;
    }

    for (const entry of entries) {
      try {
        await append({
          type: entry.type,
          actor: 'agent',
          agentName: who.agentName,
          userId: who.userId,
          threadId,
          payload: entry.payload,
        });
      } catch (error) {
        console.error(`[session-journal] append failed thread=${threadId} type=${entry.type}:`, error);
      }
    }
  };

  return {
    write(threadId, input) {
      const previous = chains.get(threadId) ?? Promise.resolve();
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
