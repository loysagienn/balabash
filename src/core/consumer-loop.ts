// The consumer loop proper, free of the database: every step that touches
// storage is injected (ConsumerIo), so the loop's one promise — it never
// ends on its own — can be tested against a fake log. src/core/consumers.ts
// wires it to the real log.
//
// Why the loop must outlive errors: on 2026-10-09 a managed-database
// restart made every poll fail for under a minute, and the loops of that
// day ended at the first error — the process stayed up, the web and the
// writers reconnected on their own, but nothing delivered events to the
// runs until a manual restart hours later. Here a failed round (the cursor
// read, the log read, the cursor write, a handler failing on connectivity)
// is waited out with a backoff and retried from the same place: the cursor
// in memory is the truth of what was handled, the persisted one catches up
// on the first good round. Only a handler failing on its own input is
// reported and skipped, as before.

import type { Event } from './contract.ts';

export type ConsumerOutage = {
  since: Date;
  until: Date;
  failures: number;
  lastError: string;
};

export type ConsumerFailing = {
  since: Date;
  failures: number;
  lastError: string;
};

export type ConsumerHealth = {
  name: string;
  // The last handled seq (null before the cursor was loaded).
  cursor: bigint | null;
  // The last successful read of the log.
  lastPollAt: Date | null;
  // The outage in progress, null while rounds succeed.
  failing: ConsumerFailing | null;
};

export type ConsumerIo = {
  loadCursor(name: string, startAtHead: boolean): Promise<bigint>;
  readAfter(seq: bigint, types: string[] | undefined, limit: number): Promise<Event[]>;
  saveCursor(name: string, seq: bigint): Promise<void>;
  // A handler failure on its own input: journaled, the event is skipped.
  reportHandlerError(name: string, event: Event, error: unknown): Promise<void>;
  // An outage that ended: journaled once, on the first good round after it.
  reportOutage(name: string, outage: ConsumerOutage): Promise<void>;
  // Connectivity errors are waited out, anything else is a failure of the call.
  isTransient(error: unknown): boolean;
  sleep(ms: number): Promise<void>;
};

export type ConsumerLoopOptions = {
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
  io: ConsumerIo;
};

export type Consumer = {
  name: string;
  stop: () => void;
};

// 1s, 2s, 4s, 8s, 16s, then 30s between retries of a failing round.
export const MAX_RETRY_BACKOFF_MS = 30_000;

export function retryBackoffMs(failures: number): number {
  return Math.min(MAX_RETRY_BACKOFF_MS, 1000 * 2 ** Math.min(Math.max(failures - 1, 0), 5));
}

// Every N-th consecutive failure is logged, so a long outage leaves a trace
// without flooding the log at every retry.
const LOG_EVERY_FAILURES = 10;

const health = new Map<string, ConsumerHealth>();

export function getConsumerHealth(): ConsumerHealth[] {
  return [...health.values()].map(entry => ({ ...entry, failing: entry.failing ? { ...entry.failing } : null }));
}

export function getFailingConsumers(): ConsumerHealth[] {
  return getConsumerHealth().filter(entry => entry.failing !== null);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function startConsumerLoop({
  name,
  handler,
  types,
  startAtHead = false,
  batchSize = 100,
  pollIntervalMs = 1000,
  io,
}: ConsumerLoopOptions): Consumer {
  let stopped = false;

  const status: ConsumerHealth = { name, cursor: null, lastPollAt: null, failing: null };

  health.set(name, status);

  const loop = async () => {
    // The handled cursor (memory) and the persisted one: they differ only
    // after a cursor write failed — the next good round writes it first.
    let cursor: bigint | null = null;
    let persisted: bigint | null = null;

    while (!stopped) {
      try {
        if (cursor === null) {
          cursor = await io.loadCursor(name, startAtHead);
          persisted = cursor;
          status.cursor = cursor;
          console.log(`[consumer:${name}] started at seq=${cursor}`);
        }

        if (persisted !== cursor) {
          await io.saveCursor(name, cursor);
          persisted = cursor;
        }

        const resolvedTypes = typeof types === 'function' ? types() : types;
        const events = await io.readAfter(cursor, resolvedTypes, batchSize);

        status.lastPollAt = new Date();

        if (status.failing) {
          const outage: ConsumerOutage = { ...status.failing, until: status.lastPollAt };

          status.failing = null;
          console.log(
            `[consumer:${name}] recovered after ${outage.failures} failed round(s) since ${outage.since.toISOString()}`,
          );

          await io.reportOutage(name, outage).catch(error => {
            console.error(`[consumer:${name}] failed to journal the outage:`, error);
          });
        }

        for (const event of events) {
          if (stopped) {
            return;
          }

          try {
            await handler(event);
          } catch (error) {
            // Connectivity lost inside the handler: the event was not
            // handled on its merits — retry it after the backoff.
            if (io.isTransient(error)) {
              throw error;
            }

            console.error(`[consumer:${name}] handler failed for event ${event.id}:`, error);

            try {
              await io.reportHandlerError(name, event, error);
            } catch (reportError) {
              console.error(`[consumer:${name}] failed to report handler error:`, reportError);
            }
          }

          cursor = event.seq;
          status.cursor = cursor;
          await io.saveCursor(name, cursor);
          persisted = cursor;
        }

        // Batch not full — we are at the head of the log, wait for new events
        if (events.length < batchSize) {
          await io.sleep(pollIntervalMs);
        }
      } catch (error) {
        const failing: ConsumerFailing = status.failing
          ? { since: status.failing.since, failures: status.failing.failures + 1, lastError: describeError(error) }
          : { since: new Date(), failures: 1, lastError: describeError(error) };

        status.failing = failing;

        const backoffMs = retryBackoffMs(failing.failures);

        if (failing.failures === 1 || failing.failures % LOG_EVERY_FAILURES === 0) {
          console.error(
            `[consumer:${name}] round failed (${failing.failures} in a row since ${failing.since.toISOString()}), retrying in ${backoffMs}ms:`,
            error,
          );
        }

        await io.sleep(backoffMs);
      }
    }
  };

  loop()
    .catch(error => {
      // Unreachable by construction (every round is caught); kept so a
      // defect here is at least loud.
      console.error(`[consumer:${name}] loop crashed:`, error);
    })
    .finally(() => {
      health.delete(name);
    });

  return {
    name,
    stop: () => {
      stopped = true;
    },
  };
}
