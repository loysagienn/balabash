// countThreadsAt over the stand's database (src/test-support/stand.ts):
// the counts by status under the listing's filters, stamped with the head
// of the log they are exact at — one snapshot, so that under a burst of
// terminals every stamp agrees with the log at that stamp.
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
let countThreadsAt: typeof import('./threads.ts')['countThreadsAt'];

before(async () => {
  stand = await startStand();
  ({ prisma } = await import('../db/client.ts'));
  ({ appendEvent } = await import('./append.ts'));
  ({ countThreadsAt } = await import('./threads.ts'));
});

after(() => stand.stop());

async function startChild(agent: string, title: string): Promise<string> {
  const id = randomUUID();

  await appendEvent({ type: 'thread.started', actor: 'system', userId: stand.userId, threadId: id, targetThreadId: stand.mainThreadId, payload: { agent, title } });

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

  test('under a burst of terminals every stamp agrees with the log at that stamp', async () => {
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

    await Promise.all(burst.map((threadId, i) => close(threadId, statuses[i % statuses.length]!)));
    closing = false;
    await counting;
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
