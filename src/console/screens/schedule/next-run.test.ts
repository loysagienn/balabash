import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { nextCronRun, nextRunOf } from './next-run.ts';

describe('the next run of a cron task in the browser', () => {
  const now = new Date('2026-10-10T20:30:00.000Z');

  it('computes the next moment in the schedule time zone', () => {
    // 4:00 Moscow is 1:00 UTC.
    assert.equal(nextCronRun('0 4 * * *', now, 'Europe/Moscow')?.toISOString(), '2026-10-11T01:00:00.000Z');
    assert.equal(nextCronRun('*/30 * * * *', now, 'UTC')?.toISOString(), '2026-10-10T21:00:00.000Z');
  });

  it('refuses what croner refuses', () => {
    assert.equal(nextCronRun('garbage', now, 'UTC'), null);
    assert.equal(nextCronRun('0 4 * * *', now, 'Nowhere/Nowhere'), null);
  });

  it('recomputes a cron task once the zone is known, else stands by the snapshot', () => {
    const stale = new Date('2026-10-10T01:00:00.000Z');

    assert.equal(nextRunOf({ cron: '0 4 * * *', nextRunAt: stale }, now, 'Europe/Moscow')?.toISOString(), '2026-10-11T01:00:00.000Z');
    assert.equal(nextRunOf({ cron: '0 4 * * *', nextRunAt: stale }, now, null), stale);
    assert.equal(nextRunOf({ cron: 'garbage', nextRunAt: stale }, now, 'UTC'), stale);
    assert.equal(nextRunOf({ cron: null, nextRunAt: stale }, now, 'UTC'), stale);
    assert.equal(nextRunOf({ cron: null, nextRunAt: null }, now, 'UTC'), null);
  });
});
