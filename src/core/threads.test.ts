// The reads of threads over the stand's database (src/test-support/
// stand.ts). countThreadsAt: the counts by status under the listing's
// filters, stamped with the head of the log — both read in one REPEATABLE
// READ snapshot: a terminal that commits between the two reads stays out of
// the counts as it is out of the stamp (held in place with a lock queue,
// and shown to tell READ COMMITTED apart), and under a run of terminals
// every stamp agrees with the log at that stamp. The rows themselves carry
// the headless policy of their thread.started, and the workspace's thread
// that ended last is the one with the greatest terminal seq.
//
// Run: npm test  (node:test, native type stripping — no build needed).

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startStand } from '../test-support/stand.ts';
import type { Stand } from '../test-support/stand.ts';
import type { JsonObject, ThreadCounts, ThreadStatus } from './contract.ts';

let stand: Stand;
let prisma: typeof import('../db/client.ts')['prisma'];
let appendEvent: typeof import('./append.ts')['appendEvent'];
let appendEventIn: typeof import('./append.ts')['appendEventIn'];
let threads: typeof import('./threads.ts');
let countThreadsAt: typeof import('./threads.ts')['countThreadsAt'];
let countThreads: typeof import('./threads.ts')['countThreads'];
let Prisma: typeof import('../../prisma-generated/client.ts')['Prisma'];

before(async () => {
  stand = await startStand();
  ({ prisma } = await import('../db/client.ts'));
  ({ appendEvent, appendEventIn } = await import('./append.ts'));
  threads = await import('./threads.ts');
  ({ countThreadsAt, countThreads } = threads);
  ({ Prisma } = await import('../../prisma-generated/client.ts'));
});

after(() => stand.stop());

async function startChild(agent: string, title: string, policy: JsonObject = {}): Promise<string> {
  const id = randomUUID();

  await appendEvent({ type: 'thread.started', actor: 'system', userId: stand.userId, threadId: id, targetThreadId: stand.mainThreadId, payload: { agent, title, ...policy } });

  return id;
}

function close(threadId: string, status: Exclude<ThreadStatus, 'active'>) {
  const payload: JsonObject = status === 'completed' ? { summary: { text: 'done' } } : status === 'failed' ? { error: 'boom' } : { reason: 'stop' };

  return appendEvent({ type: `thread.${status}`, actor: 'system', userId: stand.userId, threadId, payload });
}

async function headOfLog(): Promise<bigint> {
  return (await prisma.event.aggregate({ _max: { seq: true } }))._max.seq ?? 0n;
}

describe('countThreadsAt', () => {
  test('the counts by status under the filters, stamped with the head of the log', async () => {
    const engineerDone = await startChild('engineer', 'Engineer done');
    const engineerFailed = await startChild('engineer', 'Engineer failed');

    await startChild('engineer', 'Engineer running');

    const browserCancelled = await startChild('browser', 'Browser cancelled');

    await startChild('browser', 'Browser running');
    await close(engineerDone, 'completed');
    await close(engineerFailed, 'failed');
    await close(browserCancelled, 'cancelled');

    const head = await headOfLog();
    const all = await countThreadsAt(stand.userId, {});

    // The main thread is the third active one.
    assert.deepEqual(all, { counts: { active: 3, completed: 1, failed: 1, cancelled: 1 }, asOfSeq: head });

    const engineer = await countThreadsAt(stand.userId, { agent: 'engineer' });

    assert.deepEqual(engineer.counts, { active: 1, completed: 1, failed: 1, cancelled: 0 });

    const roots = await countThreadsAt(stand.userId, { parentId: null });

    assert.deepEqual(roots.counts, { active: 1, completed: 0, failed: 0, cancelled: 0 });

    const search = await countThreadsAt(stand.userId, { q: 'browser' });

    assert.deepEqual(search.counts, { active: 1, completed: 0, failed: 0, cancelled: 1 });

    const future = await countThreadsAt(stand.userId, { createdAtGte: new Date(Date.now() + 60 * 60 * 1000) });

    assert.deepEqual(future, { counts: { active: 0, completed: 0, failed: 0, cancelled: 0 }, asOfSeq: head });

    const stranger = await countThreadsAt(randomUUID(), {});

    assert.deepEqual(stranger.counts, { active: 0, completed: 0, failed: 0, cancelled: 0 });
  });

  test('a terminal committed between the two reads is out of the counts as it is out of the stamp — the snapshot', async () => {
    const sample = await countBetweenReads(() => countThreadsAt(stand.userId, { agent: 'wedge-rr' }), 'wedge-rr');

    assert.deepEqual(sample.counts, { active: 1, completed: 0, failed: 0, cancelled: 0 }, `at seq ${sample.asOfSeq}`);
  });

  test('the control: the same reads under READ COMMITTED count the terminal under the earlier stamp', async () => {
    const readCommitted = () =>
      prisma.$transaction(
        async tx => {
          const { _max } = await tx.event.aggregate({ _max: { seq: true } });
          const counts = await countThreads(stand.userId, { agent: 'wedge-rc' }, tx);

          return { counts, asOfSeq: _max.seq ?? 0n };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
      );
    const sample = await countBetweenReads(readCommitted, 'wedge-rc');

    assert.deepEqual(sample.counts, { active: 0, completed: 1, failed: 0, cancelled: 0 }, `at seq ${sample.asOfSeq}`);
  });

  test('under a run of terminals every stamp agrees with the log at that stamp', async () => {
    const burst: string[] = [];

    for (let i = 0; i < 6; i += 1) {
      burst.push(await startChild('burst', `Burst ${i}`));
    }

    const statuses: Exclude<ThreadStatus, 'active'>[] = ['completed', 'failed', 'cancelled'];
    const samples: { counts: ThreadCounts; asOfSeq: bigint }[] = [];
    let closing = true;
    const counting = (async () => {
      while (closing) {
        samples.push(await countThreadsAt(stand.userId, { agent: 'burst' }));
      }
    })();

    try {
      // One terminal after another: with one writer the log's order is the
      // commit order, so "closed iff the terminal's seq is at or below the
      // stamp" is exact — under concurrent writers it is not (a lower seq
      // may commit later; see the stamp's note in threads.ts). Each sample
      // meanwhile lands wherever the samples' loop is.
      for (const [i, threadId] of burst.entries()) {
        await close(threadId, statuses[i % statuses.length]!);
      }
    } finally {
      // The samples' loop ends with the test whatever closed it, and its
      // own failure is the test's: a terminal that failed does not leave
      // it counting against the stand's stop.
      closing = false;
      await counting;
    }

    samples.push(await countThreadsAt(stand.userId, { agent: 'burst' }));

    const terminals = await prisma.event.findMany({
      where: { threadId: { in: burst }, type: { in: ['thread.completed', 'thread.failed', 'thread.cancelled'] } },
      select: { seq: true, threadId: true, type: true },
    });

    assert.equal(terminals.length, burst.length);

    for (const sample of samples) {
      // The log at the stamp: a burst thread is closed iff its terminal's
      // seq is at or below asOfSeq.
      const expected: ThreadCounts = { active: 0, completed: 0, failed: 0, cancelled: 0 };

      for (const threadId of burst) {
        const terminal = terminals.find(event => event.threadId === threadId && event.seq <= sample.asOfSeq);

        expected[terminal ? (terminal.type.slice('thread.'.length) as ThreadStatus) : 'active'] += 1;
      }

      assert.deepEqual(sample.counts, expected, `at seq ${sample.asOfSeq}`);
    }

    assert.ok(samples.length >= 2, `samples: ${samples.length}`);
    assert.deepEqual(samples.at(-1)?.counts, { active: 0, completed: 2, failed: 2, cancelled: 2 });
  });
});

// One count with a terminal committed between its two reads, held in place
// by PostgreSQL's lock queue: a terminal of a fresh thread of `agent` is
// prepared in a transaction of its own (its row lock taken, nothing
// committed), a second transaction queues ACCESS EXCLUSIVE on `threads`
// behind it, and the count's second statement — the one over `threads` —
// queues behind that request (a later lock request waits behind a queued
// conflicting one), while its first statement, the head of the log, has run
// and set the transaction's snapshot. Then the terminal commits, the queue
// drains, and the count finishes. With the snapshot of the first read the
// thread is still active in the counts; without it (READ COMMITTED) the
// second read sees the terminal under the stamp the first read took.
async function countBetweenReads<T extends { counts: ThreadCounts; asOfSeq: bigint }>(count: () => Promise<T>, agent: string): Promise<T> {
  const threadId = await startChild(agent, `Between the reads (${agent})`);
  let prepared!: () => void;
  let notPrepared!: (reason: unknown) => void;
  const preparation = new Promise<void>((resolve, reject) => {
    prepared = resolve;
    notPrepared = reject;
  });
  let release!: () => void;
  let abandon!: (reason: unknown) => void;
  const released = new Promise<void>((resolve, reject) => {
    release = resolve;
    abandon = reject;
  });
  const held = prisma.$transaction(
    async tx => {
      const result = await appendEventIn(tx, { type: 'thread.completed', actor: 'system', userId: stand.userId, threadId, payload: { summary: { text: 'between' } } });

      assert.equal(result.written, true);
      prepared();
      await released;
    },
    { timeout: 20_000 },
  );

  held.catch(notPrepared);

  let locker: Promise<void> | null = null;
  let counting: Promise<T> | null = null;

  try {
    await preparation;
    locker = prisma.$transaction(async tx => {
      await tx.$executeRaw`LOCK TABLE threads IN ACCESS EXCLUSIVE MODE`;
    }, { timeout: 20_000 });
    await Promise.race([waitForLockWaiters(1), failureOf(locker)]);
    counting = count();
    await Promise.race([waitForLockWaiters(2), failureOf(locker), failureOf(counting)]);
    release();
    await held;
    await locker;

    const sample = await counting;
    const terminalSeq = (await prisma.thread.findUniqueOrThrow({ where: { id: threadId } })).terminalSeq;

    // The stamp is the head the first read saw: below the terminal.
    assert.ok(terminalSeq !== null && sample.asOfSeq < terminalSeq, `stamp ${sample.asOfSeq}, terminal ${terminalSeq}`);

    return sample;
  } finally {
    abandon(new Error('the scenario is over'));
    await Promise.allSettled([held, locker, counting]);
  }
}

// A promise that rejects when the given one does and never resolves — to
// race a wait against the failure of what it depends on.
function failureOf(promise: Promise<unknown>): Promise<never> {
  return promise.then(() => new Promise<never>(() => {}));
}

// Until at least n sessions of the stand's database wait for a lock.
async function waitForLockWaiters(n: number): Promise<void> {
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    const [row] = await prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;

    if (row && row.n >= n) {
      return;
    }

    await new Promise(resolve => setTimeout(resolve, 20));
  }

  assert.fail(`${n} lock waiter(s) never appeared`);
}

describe('the rows of threads', () => {
  test('carry the headless policy of their own thread.started, whatever read brings them', async () => {
    const headless = await startChild('gardener', 'Headless by its start', { headless: true });
    const surfaced = await startChild('engineer', 'Surfaced by its start', { headless: false });
    const silent = await startChild('engineer', 'Nothing said');
    // The payload schema is loose: an odd value is not a policy.
    const odd = await startChild('engineer', 'Odd value', { headless: 'yes' });
    const policy = (list: { id: string; headless: boolean }[]) => Object.fromEntries(list.filter(t => [headless, surfaced, silent, odd].includes(t.id)).map(t => [t.id, t.headless]));
    const expected = { [headless]: true, [surfaced]: false, [silent]: false, [odd]: false };

    assert.deepEqual(policy(await threads.listThreads(stand.userId, { agent: 'gardener' })), { [headless]: true });
    assert.deepEqual(policy(await threads.listThreads(stand.userId, { q: 'by its start' })), { [headless]: true, [surfaced]: false });
    assert.deepEqual(policy(await threads.listThreads(stand.userId)), expected);
    assert.deepEqual(policy(await threads.listActiveChildThreads()), expected);
    assert.deepEqual(policy(await threads.activeSubtree(stand.mainThreadId)), expected);
    assert.equal((await threads.getThread(headless))?.headless, true);
    assert.equal((await threads.getThread(silent))?.headless, false);
    assert.equal((await threads.getMainThread(stand.userId))?.headless, false);
    assert.equal((await threads.getThread(randomUUID())), null);
    // The projection's row does not store it: the join is the only source.
    assert.equal('headless' in (await prisma.thread.findUniqueOrThrow({ where: { id: headless } })), false);
  });

  test('the thread that ended last is the greatest terminal seq, whatever its age', async () => {
    const stranger = randomUUID();

    assert.equal(await threads.getLatestTerminalThread(stranger), null);

    const older = await startChild('engineer', 'Older, ends last');
    const newer = await startChild('engineer', 'Newer, ends first');

    await close(newer, 'completed');

    const first = await threads.getLatestTerminalThread(stand.userId);

    assert.equal(first?.id, newer);

    const ended = await close(older, 'failed');
    const last = await threads.getLatestTerminalThread(stand.userId);

    assert.equal(last?.id, older);
    assert.equal(last?.status, 'failed');
    assert.ok(ended.written);
    assert.equal(last?.terminalSeq, ended.event.seq);
    assert.ok(last!.createdSeq < first!.createdSeq);
    assert.equal(await threads.getLatestTerminalThread(stranger), null);
  });
});
