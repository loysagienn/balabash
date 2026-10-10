// The snapshot's thread window over a fake log: every active thread comes
// whatever their number (the pages run until a short one), the main thread
// and the thread that ended last are there even when the limits would
// leave them out, nothing is doubled.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Thread, ThreadStatus } from '../core/contract.ts';
import { ACTIVE_PAGE, SNAPSHOT_THREAD_WINDOW, readThreadWindow } from './thread-window.ts';
import type { ThreadWindowReads } from './thread-window.ts';

function thread(id: string, createdSeq: bigint, status: ThreadStatus, parentId: string | null = 'main'): Thread {
  const createdAt = new Date(1_700_000_000_000 + Number(createdSeq) * 1000);

  return { id, userId: 'u1', parentId, agent: 'engineer', title: null, description: null, status, summary: null, projectId: null, headless: false, createdSeq, terminalSeq: null, createdAt, updatedAt: createdAt };
}

// A log of `active` active children above the root (createdSeq 1) and
// `closed` completed ones between — the reads page it like the database.
function fakeReads(threads: Thread[]): ThreadWindowReads & { calls: { list: number; get: number; latestTerminal: number } } {
  const calls = { list: 0, get: 0, latestTerminal: 0 };
  const newestFirst = [...threads].sort((a, b) => (a.createdSeq > b.createdSeq ? -1 : 1));

  return {
    calls,
    list: async (_userId, { status, beforeCreatedSeq, limit }) => {
      calls.list += 1;

      return newestFirst.filter(t => (status === undefined || t.status === status) && (beforeCreatedSeq === undefined || t.createdSeq < beforeCreatedSeq)).slice(0, limit);
    },
    get: async id => {
      calls.get += 1;

      return threads.find(t => t.id === id) ?? null;
    },
    latestTerminal: async () => {
      calls.latestTerminal += 1;

      return threads.filter(t => t.terminalSeq !== null).sort((a, b) => (a.terminalSeq! > b.terminalSeq! ? -1 : 1))[0] ?? null;
    },
  };
}

function workspace(active: number, closed = 0): Thread[] {
  const threads = [thread('main', 1n, 'active', null)];
  let seq = 2n;

  for (let i = 0; i < closed; i += 1, seq += 1n) {
    threads.push(thread(`c${i}`, seq, 'completed'));
  }

  for (let i = 0; i < active; i += 1, seq += 1n) {
    threads.push(thread(`a${i}`, seq, 'active'));
  }

  return threads;
}

describe('snapshot thread window', () => {
  for (const active of [ACTIVE_PAGE - 2, ACTIVE_PAGE - 1, ACTIVE_PAGE, ACTIVE_PAGE + 1, ACTIVE_PAGE * 2 + 3]) {
    it(`holds every active thread and the main thread with ${active} active children`, async () => {
      const reads = fakeReads(workspace(active, SNAPSHOT_THREAD_WINDOW + 50));
      const window = await readThreadWindow('u1', 'main', reads);
      const ids = new Set(window.map(t => t.id));

      assert.equal(window.filter(t => t.status === 'active').length, active + 1);
      assert.ok(ids.has('main'));
      assert.equal(ids.size, window.length);
      // The newest 200 of any status ride along; older closed ones do not.
      const all = workspace(active, SNAPSHOT_THREAD_WINDOW + 50).sort((a, b) => (a.createdSeq > b.createdSeq ? -1 : 1));

      assert.ok(all.slice(0, SNAPSHOT_THREAD_WINDOW).every(t => ids.has(t.id)));
      assert.equal(ids.has('c0'), false);
      assert.deepEqual(window.map(t => t.createdSeq), [...window].sort((a, b) => (a.createdSeq > b.createdSeq ? -1 : 1)).map(t => t.createdSeq));
      // The pages brought the root (it is active): no lookup by id.
      assert.equal(reads.calls.get, 0);
    });
  }

  it('looks the main thread up by id when the pages leave it out', async () => {
    // A root the status pages would not return (not active in this log).
    const threads = workspace(ACTIVE_PAGE + 1, SNAPSHOT_THREAD_WINDOW + 50);

    threads[0] = { ...threads[0]!, status: 'completed' };

    const reads = fakeReads(threads);
    const window = await readThreadWindow('u1', 'main', reads);

    assert.ok(window.some(t => t.id === 'main'));
    assert.equal(reads.calls.get, 1);
    assert.equal(window.filter(t => t.status === 'active').length, ACTIVE_PAGE + 1);
  });

  it('is content with the pages when the main thread id is unknown', async () => {
    const reads = fakeReads(workspace(3));

    assert.equal((await readThreadWindow('u1', null, reads)).length, 4);
    assert.equal(reads.calls.get, 0);
  });

  it('holds the thread that ended last even when it is older than the window', async () => {
    // Every closed thread of the log has ended — the oldest of them last
    // (an old thread that finished after everything else), the rest in
    // their creation order.
    const threads = workspace(3, SNAPSHOT_THREAD_WINDOW + 50).map(t => (t.status === 'completed' ? { ...t, terminalSeq: t.id === 'c0' ? 10_000n : t.createdSeq + 1n } : t));
    const reads = fakeReads(threads);
    const window = await readThreadWindow('u1', 'main', reads);

    assert.ok(window.some(t => t.id === 'c0'));
    assert.equal(reads.calls.latestTerminal, 1);
    assert.equal(window.filter(t => t.id === 'c0').length, 1);
    // The newest 200 (the three active ones among them), the main thread and c0.
    assert.equal(window.length, SNAPSHOT_THREAD_WINDOW + 2);
    assert.deepEqual(window.map(t => t.createdSeq), [...window].sort((a, b) => (a.createdSeq > b.createdSeq ? -1 : 1)).map(t => t.createdSeq));

    // The thread that ended last is the newest closed one — in the window
    // already: nothing is added, nothing doubled.
    const recent = threads.map(t => (t.id === 'c0' ? { ...t, terminalSeq: 3n } : t));
    const again = await readThreadWindow('u1', 'main', fakeReads(recent));

    assert.equal(again.some(t => t.id === 'c0'), false);
    assert.equal(again.length, SNAPSHOT_THREAD_WINDOW + 1);
    assert.equal(new Set(again.map(t => t.id)).size, again.length);
  });

  it('is content without a terminal when nothing has ended', async () => {
    const reads = fakeReads(workspace(2));

    assert.equal((await readThreadWindow('u1', 'main', reads)).length, 3);
    assert.equal(reads.calls.latestTerminal, 1);
  });
});
