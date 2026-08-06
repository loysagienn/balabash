// Polling consumer loop over the event log — a straight port of v1's
// event-bus (§4.4). Consumers are orthogonal to threads: a thread bounds
// transcripts, not consumers.

import { prisma } from '../db/client.ts';
import type { Event } from './contract.ts';
import { SYSTEM_EXCEPTION } from './envelope.ts';
import { appendEvent } from './append.ts';
import { getEventsAfter } from './events.ts';
import { getMainThread } from './threads.ts';

type ConsumerOptions = {
  name: string;
  handler: (event: Event) => Promise<void>;
  // Only receive events of these types; a function allows the subscription to
  // follow runtime registry changes. Omit to receive everything.
  types?: string[] | (() => string[]);
  // Start at the head of the log on the very first run instead of replaying
  // everything already recorded. For consumers whose handling is visible
  // outside the system, where replaying history would be worse than missing it.
  startAtHead?: boolean;
  batchSize?: number;
  pollIntervalMs?: number;
};

export type Consumer = {
  name: string;
  stop: () => void;
};

async function getConsumerCursor(name: string): Promise<bigint> {
  const consumer = await prisma.eventConsumer.upsert({
    where: { name },
    create: { name },
    update: {},
  });

  return consumer.lastSeq;
}

async function registerConsumerAtHead(name: string): Promise<bigint> {
  const { _max } = await prisma.event.aggregate({ _max: { seq: true } });

  const consumer = await prisma.eventConsumer.upsert({
    where: { name },
    create: { name, lastSeq: _max.seq ?? 0n },
    update: {},
  });

  return consumer.lastSeq;
}

async function setConsumerCursor(name: string, lastSeq: bigint): Promise<void> {
  await prisma.eventConsumer.update({
    where: { name },
    data: { lastSeq },
  });
}

// A handler error is journaled as system.exception into the workspace's main
// thread (§4.2) and skipped, so one bad event cannot block the consumer.
// A crash after handling but before advancing the cursor can redeliver, so
// handlers must remain idempotent.
async function reportHandlerError(consumerName: string, event: Event, error: unknown): Promise<void> {
  const mainThread = event.userId ? await getMainThread(event.userId) : null;

  await appendEvent({
    type: SYSTEM_EXCEPTION,
    actor: 'system',
    userId: event.userId,
    threadId: mainThread?.id ?? null,
    payload: {
      consumerName,
      eventId: event.id,
      eventType: event.type,
      error: error instanceof Error ? error.message : String(error),
    },
  });
}

export function startConsumer({
  name,
  handler,
  types,
  startAtHead = false,
  batchSize = 100,
  pollIntervalMs = 1000,
}: ConsumerOptions): Consumer {
  let stopped = false;

  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

  const loop = async () => {
    let cursor = startAtHead ? await registerConsumerAtHead(name) : await getConsumerCursor(name);

    console.log(`[consumer:${name}] started at seq=${cursor}`);

    while (!stopped) {
      const resolvedTypes = typeof types === 'function' ? types() : types;
      const events = await getEventsAfter(cursor, { types: resolvedTypes, limit: batchSize });

      for (const event of events) {
        if (stopped) {
          return;
        }

        try {
          await handler(event);
        } catch (error) {
          console.error(`[consumer:${name}] handler failed for event ${event.id}:`, error);

          try {
            await reportHandlerError(name, event, error);
          } catch (reportError) {
            console.error(`[consumer:${name}] failed to report handler error:`, reportError);
          }
        }

        cursor = event.seq;
        await setConsumerCursor(name, cursor);
      }

      // Batch not full — we are at the head of the log, wait for new events
      if (events.length < batchSize) {
        await sleep(pollIntervalMs);
      }
    }
  };

  loop().catch(error => {
    console.error(`[consumer:${name}] loop crashed:`, error);
  });

  return {
    name,
    stop: () => {
      stopped = true;
    },
  };
}
