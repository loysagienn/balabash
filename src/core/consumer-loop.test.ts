import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Event } from './contract.ts';
import { getConsumerHealth, retryBackoffMs, startConsumerLoop } from './consumer-loop.ts';
import type { ConsumerIo, ConsumerOutage } from './consumer-loop.ts';

function makeEvent(seq: number): Event {
  return {
    seq: BigInt(seq),
    id: `e${seq}`,
    type: 'user.message',
    actor: 'user',
    agentName: null,
    userId: 'u',
    threadId: 't',
    targetThreadId: null,
    payload: { text: String(seq) },
    schemaVersion: 1,
    createdAt: new Date(0),
  };
}

class Transient extends Error {
  code = 'P1001';
}

const tick = () => new Promise(resolve => setImmediate(resolve));
const settle = async (rounds = 40) => {
  for (let i = 0; i < rounds; i += 1) {
    await tick();
  }
};

// A fake log: in-memory events, a cursor store, scripted failures per step,
// sleeps that resolve at once but are recorded.
function makeIo(log: Event[]) {
  const cursors = new Map<string, bigint>();
  const sleeps: number[] = [];
  const outages: ConsumerOutage[] = [];
  const handlerReports: Array<{ event: Event; error: unknown }> = [];
  const failures = { load: 0, read: 0, save: 0 };
  let reads = 0;

  const io: ConsumerIo = {
    async loadCursor(name) {
      if (failures.load > 0) {
        failures.load -= 1;
        throw new Transient('load failed');
      }

      return cursors.get(name) ?? 0n;
    },
    async readAfter(seq, _types, limit) {
      reads += 1;

      if (failures.read > 0) {
        failures.read -= 1;
        throw new Transient("Can't reach database server");
      }

      return log.filter(event => event.seq > seq).slice(0, limit);
    },
    async saveCursor(name, seq) {
      if (failures.save > 0) {
        failures.save -= 1;
        throw new Transient('save failed');
      }

      cursors.set(name, seq);
    },
    async reportHandlerError(_name, event, error) {
      handlerReports.push({ event, error });
    },
    async reportOutage(_name, outage) {
      outages.push(outage);
    },
    isTransient: error => error instanceof Transient,
    async sleep(ms) {
      sleeps.push(ms);
      await tick();
    },
  };

  return {
    io,
    cursors,
    sleeps,
    outages,
    handlerReports,
    failures,
    reads: () => reads,
  };
}

describe('consumer loop', () => {
  it('handles events in order and persists the cursor after each', async () => {
    const log = [makeEvent(1), makeEvent(2), makeEvent(3)];
    const fake = makeIo(log);
    const handled: bigint[] = [];
    const consumer = startConsumerLoop({
      name: 'order',
      handler: async event => {
        handled.push(event.seq);
      },
      io: fake.io,
    });

    await settle();
    consumer.stop();
    await settle();

    assert.deepEqual(handled, [1n, 2n, 3n]);
    assert.equal(fake.cursors.get('order'), 3n);
  });

  it('survives a log read failure: backs off, retries, resumes from the cursor and journals the outage once', async () => {
    const log = [makeEvent(1)];
    const fake = makeIo(log);
    const handled: bigint[] = [];

    fake.failures.read = 3;

    const consumer = startConsumerLoop({
      name: 'outage',
      handler: async event => {
        handled.push(event.seq);
      },
      io: fake.io,
    });

    await settle();

    assert.deepEqual(handled, [1n]);
    assert.equal(fake.cursors.get('outage'), 1n);
    assert.deepEqual(fake.sleeps.slice(0, 3), [1000, 2000, 4000]);
    assert.equal(fake.outages.length, 1);
    assert.equal(fake.outages[0]!.failures, 3);
    assert.match(fake.outages[0]!.lastError, /Can't reach database server/);
    assert.equal(fake.handlerReports.length, 0);

    // Events appended after the recovery still flow.
    log.push(makeEvent(2));
    await settle();
    assert.deepEqual(handled, [1n, 2n]);
    assert.equal(fake.outages.length, 1);

    consumer.stop();
    await settle();
  });

  it('retries the same event when the handler fails on connectivity, instead of skipping it', async () => {
    const log = [makeEvent(1), makeEvent(2)];
    const fake = makeIo(log);
    const attempts: bigint[] = [];
    let failOnce = true;
    const consumer = startConsumerLoop({
      name: 'handler-transient',
      handler: async event => {
        attempts.push(event.seq);

        if (failOnce && event.seq === 1n) {
          failOnce = false;
          throw new Transient('connection terminated');
        }
      },
      io: fake.io,
    });

    await settle();
    consumer.stop();
    await settle();

    assert.deepEqual(attempts, [1n, 1n, 2n]);
    assert.equal(fake.cursors.get('handler-transient'), 2n);
    assert.equal(fake.handlerReports.length, 0);
    assert.equal(fake.outages.length, 1);
  });

  it('reports and skips a handler failing on its own input', async () => {
    const log = [makeEvent(1), makeEvent(2)];
    const fake = makeIo(log);
    const attempts: bigint[] = [];
    const consumer = startConsumerLoop({
      name: 'handler-bad',
      handler: async event => {
        attempts.push(event.seq);

        if (event.seq === 1n) {
          throw new Error('bad payload');
        }
      },
      io: fake.io,
    });

    await settle();
    consumer.stop();
    await settle();

    assert.deepEqual(attempts, [1n, 2n]);
    assert.equal(fake.handlerReports.length, 1);
    assert.equal(fake.handlerReports[0]!.event.seq, 1n);
    assert.equal(fake.cursors.get('handler-bad'), 2n);
    assert.equal(fake.outages.length, 0);
  });

  it('does not re-handle an event whose cursor write failed; the cursor catches up on the next good round', async () => {
    const log = [makeEvent(1), makeEvent(2)];
    const fake = makeIo(log);
    const attempts: bigint[] = [];

    fake.failures.save = 1;

    const consumer = startConsumerLoop({
      name: 'save',
      handler: async event => {
        attempts.push(event.seq);
      },
      io: fake.io,
    });

    await settle();
    consumer.stop();
    await settle();

    assert.deepEqual(attempts, [1n, 2n]);
    assert.equal(fake.cursors.get('save'), 2n);
    assert.equal(fake.outages.length, 1);
  });

  it('survives a cursor load failure at start', async () => {
    const log = [makeEvent(1)];
    const fake = makeIo(log);
    const handled: bigint[] = [];

    fake.failures.load = 2;

    const consumer = startConsumerLoop({
      name: 'load',
      handler: async event => {
        handled.push(event.seq);
      },
      io: fake.io,
    });

    await settle();
    consumer.stop();
    await settle();

    assert.deepEqual(handled, [1n]);
    assert.equal(fake.outages.length, 1);
    assert.equal(fake.outages[0]!.failures, 2);
  });

  it('exposes the outage in health while it lasts and clears it on recovery', async () => {
    const log = [makeEvent(1)];
    const fake = makeIo(log);

    fake.failures.read = 2;

    const consumer = startConsumerLoop({ name: 'health', handler: async () => {}, io: fake.io });

    // The first round fails synchronously enough to be visible after a tick.
    await tick();
    await tick();

    const failing = getConsumerHealth().find(entry => entry.name === 'health');

    assert.ok(failing);
    assert.ok(failing.failing);
    assert.ok(failing.failing.failures >= 1);

    await settle();

    const recovered = getConsumerHealth().find(entry => entry.name === 'health');

    assert.ok(recovered);
    assert.equal(recovered.failing, null);
    assert.equal(recovered.cursor, 1n);
    assert.ok(recovered.lastPollAt);

    consumer.stop();
    await settle();
    assert.equal(
      getConsumerHealth().find(entry => entry.name === 'health'),
      undefined,
    );
  });

  it('backs off exponentially and caps at 30s', () => {
    assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 50].map(retryBackoffMs), [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  });
});
