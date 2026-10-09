// Polling consumer loop over the event log — a straight port of v1's
// event-bus (§4.4). Consumers are orthogonal to threads: a thread bounds
// transcripts, not consumers. The loop itself lives in consumer-loop.ts
// (storage injected, testable); this module binds it to the real log and
// is the one the app imports.

import { prisma } from '../db/client.ts';
import { isConnectivityError } from '../db/connectivity.ts';
import type { Event } from './contract.ts';
import { SYSTEM_EXCEPTION } from './envelope.ts';
import { appendEvent } from './append.ts';
import { getEventsAfter } from './events.ts';
import { getMainThread } from './threads.ts';
import { startConsumerLoop } from './consumer-loop.ts';
import type { Consumer, ConsumerIo, ConsumerLoopOptions, ConsumerOutage } from './consumer-loop.ts';

export type { Consumer, ConsumerHealth } from './consumer-loop.ts';
export { getConsumerHealth, getFailingConsumers } from './consumer-loop.ts';

type ConsumerOptions = Omit<ConsumerLoopOptions, 'io'>;

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

// An outage is installation-level (the log itself was unreachable, no
// workspace owns that), journaled once it is over — like a failed migration
// or a supervisor rollback: the fact reaches the log as soon as the log is
// back, with the span and the last error for the record.
async function reportOutage(consumerName: string, outage: ConsumerOutage): Promise<void> {
  await appendEvent({
    type: SYSTEM_EXCEPTION,
    actor: 'system',
    userId: null,
    payload: {
      scope: 'consumer-outage',
      consumerName,
      since: outage.since.toISOString(),
      until: outage.until.toISOString(),
      failures: outage.failures,
      error:
        `Consumer "${consumerName}" could not reach the log for ${outage.failures} round(s) ` +
        `(${outage.since.toISOString()} – ${outage.until.toISOString()}) and resumed from its cursor: ${outage.lastError}`,
    },
  });
}

const io: ConsumerIo = {
  loadCursor: (name, startAtHead) => (startAtHead ? registerConsumerAtHead(name) : getConsumerCursor(name)),
  readAfter: (seq, types, limit) => getEventsAfter(seq, { types, limit }),
  saveCursor: setConsumerCursor,
  reportHandlerError,
  reportOutage,
  isTransient: isConnectivityError,
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
};

export function startConsumer(options: ConsumerOptions): Consumer {
  return startConsumerLoop({ ...options, io });
}
