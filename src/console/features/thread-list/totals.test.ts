import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { RECENT_DAYS, failureOf, knownTotal, recentSince, totalOf, totalWithTail } from './totals.ts';

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
    const now = new Date('2026-10-09T16:38:12.345Z');
    const since = recentSince(now);

    assert.equal(RECENT_DAYS, 30);
    assert.equal(since.toISOString(), '2026-09-09T16:00:00.000Z');
    assert.equal(recentSince(new Date('2026-10-09T16:59:59.999Z')).getTime(), since.getTime());
    assert.notEqual(recentSince(new Date('2026-10-09T17:00:00.000Z')).getTime(), since.getTime());
  });

  it('rounds the start by the epoch hour, so the repeated hour of a DST fall-back does not move it a second hour back', () => {
    // The process clock follows TZ; node reads the variable anew on each
    // Date operation, so the zone can change inside the test (restored after).
    const zone = process.env.TZ;

    try {
      // 30 days before 2026-11-23T23:30Z is 2026-10-24T23:30Z — 01:30 of the
      // repeated hour in Israel (the clocks fall back at 02:00 on 25 October).
      process.env.TZ = 'Asia/Jerusalem';
      assert.equal(recentSince(new Date('2026-11-23T23:30:00Z')).toISOString(), '2026-10-24T23:00:00.000Z');
      // 1 November in New York: 01:30 EDT is 05:30Z, the hour repeats.
      process.env.TZ = 'America/New_York';
      assert.equal(recentSince(new Date('2026-12-01T06:30:00Z')).toISOString(), '2026-11-01T06:00:00.000Z');
      assert.equal(recentSince(new Date('2026-10-09T16:38:12Z')).toISOString(), '2026-09-09T16:00:00.000Z');
    } finally {
      if (zone === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = zone;
      }
    }
  });

  it('knows no total while the request stands in error, whatever Query kept from an earlier answer', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let answer: () => { counts: typeof counts; countsAsOfSeq: bigint } = () => ({ counts, countsAsOfSeq: 900n });
    const observer = new QueryObserver(client, { queryKey: ['thread-total', 'engineer'], queryFn: async () => answer(), select: totalOf });
    const stop = observer.subscribe(() => {});
    const threads = [{ createdSeq: 901n, createdAt: new Date('2026-10-09T11:00:00Z') }];

    try {
      await new Promise<void>(resolve => {
        const unsubscribe = observer.subscribe(result => {
          if (result.isSuccess) {
            unsubscribe();
            resolve();
          }
        });
      });
      // The answer, brought up to the tail.
      assert.equal(knownTotal(observer.getCurrentResult(), threads), 215);

      // The refetch fails; Query keeps the data beside the error.
      answer = () => {
        throw new Error('HTTP 500');
      };
      await observer.refetch();

      const failed = observer.getCurrentResult();

      assert.equal(failed.isError, true);
      assert.deepEqual(failed.data, { total: 214, asOfSeq: 900n });
      assert.equal(knownTotal(failed, threads), null);

      // The next answer is the total again.
      answer = () => ({ counts: { ...counts, completed: 201 }, countsAsOfSeq: 902n });
      await observer.refetch();
      assert.equal(knownTotal(observer.getCurrentResult(), threads), 215);
    } finally {
      stop();
      client.clear();
    }

    // Before any answer there is none either.
    assert.equal(knownTotal({ data: undefined, isError: false }, threads), null);
    assert.equal(knownTotal({ data: null, isError: false }, threads), null);
  });

  it('names the failure of the set’s requests and retries only the ones that failed', () => {
    const calls: string[] = [];
    const query = (name: string, error: Error | null, isFetching = false) => ({
      isError: error !== null,
      error,
      isFetching,
      refetch: () => {
        calls.push(name);
        return Promise.resolve();
      },
    });

    assert.equal(failureOf([query('all', null), query('recent', null)]), null);
    assert.equal(failureOf([]), null);

    const one = failureOf([query('all', null), query('recent', new Error('HTTP 500'))]);

    assert.equal(one?.message, 'HTTP 500');
    assert.equal(one?.pending, false);
    one?.retry();
    assert.deepEqual(calls, ['recent']);

    const both = failureOf([query('all', new Error('network'), true), query('recent', new Error('HTTP 500'))]);

    assert.equal(both?.message, 'network');
    assert.equal(both?.pending, true);
    both?.retry();
    assert.deepEqual(calls, ['recent', 'all', 'recent']);
  });
});
