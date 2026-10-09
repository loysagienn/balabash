// The live tail of the event log, in-process: appendEvent signals every
// commit here, one reader turns signals into events (read from the log —
// the log is the base, a signal is only a hint) and hands them to the
// subscribers (the console's event stream). Single core process, so an
// in-process hub is enough; a safety poll covers a lost signal.
//
// Ordering: one reader, one cursor, pages read in seq order and dispatched
// in seq order — a subscriber never sees seq go backwards and never sees a
// gap, whatever the number of signals coalesced into one read.

import type { Event } from './contract.ts';

export type LiveListener = (events: Event[]) => void;

export type LiveHubOptions = {
  // Reads events strictly after seq, oldest first, at most limit — the log
  // reader (getEventsAfter) in production, a fake in tests.
  readAfter: (seq: bigint, limit: number) => Promise<Event[]>;
  // The head of the log when the first subscriber arrives: the hub starts
  // tailing from there, never replaying history (subscribers catch up on
  // their own from their own cursor).
  headSeq: () => Promise<bigint>;
  pageSize?: number;
  pollIntervalMs?: number;
};

export type LiveHub = {
  // Called after a commit: "there is something after seq".
  notify(seq: bigint): void;
  subscribe(listener: LiveListener): () => void;
  // Test/shutdown aid: stop the poll timer and drop the subscribers.
  close(): void;
};

export function createLiveHub({ readAfter, headSeq, pageSize = 500, pollIntervalMs = 2000 }: LiveHubOptions): LiveHub {
  const listeners = new Set<LiveListener>();
  let cursor: bigint | null = null;
  let hinted: bigint | null = null;
  let reading: Promise<void> | null = null;
  let timer: NodeJS.Timeout | null = null;

  const dispatch = (events: Event[]) => {
    for (const listener of listeners) {
      try {
        listener(events);
      } catch (error) {
        console.error('[live] listener failed:', error);
      }
    }
  };

  // One read at a time; a signal that lands during a read schedules the
  // next one (the page loop would have caught it anyway, but the check is
  // cheap and keeps the tail tight).
  const drain = async (): Promise<void> => {
    if (cursor === null) {
      cursor = await headSeq();
    }

    for (;;) {
      const from = cursor;
      const page = await readAfter(from, pageSize);

      if (page.length) {
        cursor = page[page.length - 1]!.seq;
        dispatch(page);
      }

      if (page.length < pageSize && (hinted === null || hinted <= cursor)) {
        hinted = null;

        return;
      }
    }
  };

  const kick = () => {
    if (!listeners.size || reading) {
      return;
    }

    reading = drain()
      .catch(error => {
        console.error('[live] read failed:', error);
      })
      .finally(() => {
        reading = null;

        // A hint arrived while the read was finishing: go again.
        if (hinted !== null && listeners.size) {
          kick();
        }
      });
  };

  const armPoll = () => {
    if (!timer && listeners.size) {
      timer = setInterval(() => {
        hinted ??= cursor ?? 0n;
        kick();
      }, pollIntervalMs);
      timer.unref();
    }
  };

  const disarmPoll = () => {
    if (timer && !listeners.size) {
      clearInterval(timer);
      timer = null;
    }
  };

  return {
    notify(seq) {
      if (!listeners.size) {
        return;
      }

      hinted = hinted === null || seq > hinted ? seq : hinted;
      kick();
    },

    subscribe(listener) {
      listeners.add(listener);
      armPoll();

      // Pin the cursor now, so events appended between subscribing and
      // the first read are not skipped by a later headSeq().
      if (cursor === null && !reading) {
        hinted ??= 0n;
        kick();
      }

      return () => {
        listeners.delete(listener);
        disarmPoll();
      };
    },

    close() {
      listeners.clear();
      disarmPoll();
    },
  };
}

// --------------------------------------------------------------------------
// The process-wide hub over the real log. Wired lazily: the reader is
// injected by src/core/events.ts consumers at first use so this module
// stays free of the database import cycle (append.ts imports it).

let hub: LiveHub | null = null;
let factory: (() => LiveHub) | null = null;

export function installLiveHub(create: () => LiveHub): void {
  factory = create;
}

export function getLiveHub(): LiveHub {
  if (!hub) {
    if (!factory) {
      throw new Error('live hub is not installed (src/core/events.ts installs it at import)');
    }

    hub = factory();
  }

  return hub;
}

// Fire-and-forget from the write path: never throws, never awaits.
export function notifyAppended(seq: bigint): void {
  if (!factory) {
    return;
  }

  try {
    getLiveHub().notify(seq);
  } catch (error) {
    console.error('[live] notify failed:', error);
  }
}
