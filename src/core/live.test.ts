import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Event } from './contract.ts';
import { createLiveHub } from './live.ts';

function makeEvent(seq: number): Event {
  return {
    seq: BigInt(seq),
    id: `e${seq}`,
    type: 'thread.progress',
    actor: 'agent',
    agentName: 'engineer',
    userId: 'u',
    threadId: 't',
    targetThreadId: null,
    payload: { text: String(seq) },
    schemaVersion: 1,
    createdAt: new Date(0),
  };
}

const tick = () => new Promise(resolve => setImmediate(resolve));
const settle = async () => {
  for (let i = 0; i < 10; i += 1) {
    await tick();
  }
};

describe('live hub', () => {
  it('tails from the head, dispatches pages in seq order, coalesces hints', async () => {
    const log: Event[] = [makeEvent(1), makeEvent(2)];
    let reads = 0;
    const hub = createLiveHub({
      readAfter: async (seq, limit) => {
        reads += 1;

        return log.filter(event => event.seq > seq).slice(0, limit);
      },
      headSeq: async () => 2n,
      pageSize: 2,
      pollIntervalMs: 60_000,
    });
    const seen: bigint[] = [];
    const unsubscribe = hub.subscribe(events => seen.push(...events.map(event => event.seq)));

    await settle();
    assert.deepEqual(seen, []);

    log.push(makeEvent(3), makeEvent(4), makeEvent(5));
    hub.notify(3n);
    hub.notify(4n);
    hub.notify(5n);
    await settle();

    assert.deepEqual(seen, [3n, 4n, 5n]);
    // Three hints, few reads: a cold-start read, then the pages of one drain.
    assert.ok(reads <= 4, `reads: ${reads}`);

    unsubscribe();
    hub.notify(6n);
    await settle();
    assert.deepEqual(seen, [3n, 4n, 5n]);
    hub.close();
  });

  it('does not read at all without subscribers', async () => {
    let reads = 0;
    const hub = createLiveHub({
      readAfter: async () => {
        reads += 1;

        return [];
      },
      headSeq: async () => 0n,
      pollIntervalMs: 60_000,
    });

    hub.notify(1n);
    await settle();
    assert.equal(reads, 0);
    hub.close();
  });

  it('a listener error does not break the others', async () => {
    const log: Event[] = [];
    const hub = createLiveHub({
      readAfter: async seq => log.filter(event => event.seq > seq),
      headSeq: async () => 0n,
      pollIntervalMs: 60_000,
    });
    const seen: bigint[] = [];
    const errors: string[] = [];
    const original = console.error;

    console.error = (...args: unknown[]) => errors.push(String(args[0]));
    hub.subscribe(() => {
      throw new Error('bad listener');
    });
    hub.subscribe(events => seen.push(...events.map(event => event.seq)));
    await settle();

    log.push(makeEvent(1));
    hub.notify(1n);
    await settle();
    console.error = original;

    assert.deepEqual(seen, [1n]);
    assert.ok(errors.some(line => line.includes('listener failed')));
    hub.close();
  });
});
