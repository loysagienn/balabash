import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RECENT_DAYS, recentSince, totalOf, totalWithTail } from './totals.ts';

describe('thread totals', () => {
  const counts = { active: 3, completed: 200, failed: 7, cancelled: 4 };

  it('sums the first page’s counts with their stamp', () => {
    assert.deepEqual(totalOf({ counts, countsAsOfSeq: 900n }), { total: 214, asOfSeq: 900n });
    assert.deepEqual(totalOf({ counts }), { total: 214, asOfSeq: null });
    assert.equal(totalOf({}), null);
  });

  it('adds the threads the tail started above the stamp, inside the window when one is given', () => {
    const since = new Date('2026-09-09T00:00:00Z');
    const threads = [
      { createdSeq: 880n, createdAt: new Date('2026-10-09T10:00:00Z') }, // counted already
      { createdSeq: 901n, createdAt: new Date('2026-10-09T11:00:00Z') }, // new
      { createdSeq: 905n, createdAt: new Date('2026-08-01T00:00:00Z') }, // new, outside the window
    ];

    assert.equal(totalWithTail({ total: 214, asOfSeq: 900n }, threads), 216);
    assert.equal(totalWithTail({ total: 61, asOfSeq: 900n }, threads, since), 62);
    assert.equal(totalWithTail({ total: 214, asOfSeq: 900n }, []), 214);
    assert.equal(totalWithTail({ total: 214, asOfSeq: null }, threads), 214);
  });

  it('starts the recent window 30 days back, at the hour', () => {
    const now = new Date(2026, 9, 9, 16, 38, 12, 345);
    const since = recentSince(now);

    assert.equal(RECENT_DAYS, 30);
    assert.equal(since.getTime(), new Date(2026, 8, 9, 16, 0, 0, 0).getTime());
    assert.equal(recentSince(new Date(2026, 9, 9, 16, 59)).getTime(), since.getTime());
    assert.notEqual(recentSince(new Date(2026, 9, 9, 17, 0)).getTime(), since.getTime());
  });
});
