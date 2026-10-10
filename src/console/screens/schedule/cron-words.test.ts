import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cronWords } from './cron-words.ts';

describe('a cron expression spelled out', () => {
  it('reads minutes and hours', () => {
    assert.equal(cronWords('* * * * *'), 'every minute');
    assert.equal(cronWords('*/30 * * * *'), 'every 30 minutes');
    assert.equal(cronWords('*/10 * * * *'), 'every 10 minutes');
    assert.equal(cronWords('0 * * * *'), 'every hour');
    assert.equal(cronWords('15 * * * *'), 'hourly at :15');
    assert.equal(cronWords('0 */6 * * *'), 'every 6 hours');
    assert.equal(cronWords('0 */2 * * *'), 'every 2 hours');
    assert.equal(cronWords('30 */2 * * *'), 'every 2 hours at :30');
    assert.equal(cronWords('0 1-23/2 * * *'), 'every 2 hours from 1:00 to 23:00');
    assert.equal(cronWords('30 1-23/2 * * *'), 'every 2 hours at :30 from 1:30 to 23:30');
    assert.equal(cronWords('*/20 * * * *'), 'every 20 minutes');
    assert.equal(cronWords('0 */8 * * *'), 'every 8 hours');
  });

  it('does not call a step that restarts at the hour or the day an even interval', () => {
    // */7: :00, :07, …, :56, then :00 — the last gap is four minutes.
    assert.equal(cronWords('*/7 * * * *'), null);
    assert.equal(cronWords('*/45 * * * *'), null);
    // */5 hours: 0, 5, 10, 15, 20, then 0 — the last gap is four hours.
    assert.equal(cronWords('0 */5 * * *'), null);
    assert.equal(cronWords('15 */7 * * *'), null);
    // Within a range the words name the hours the step reaches.
    assert.equal(cronWords('0 0-23/5 * * *'), 'every 5 hours from 0:00 to 20:00');
    assert.equal(cronWords('0 9-17/3 * * *'), 'every 3 hours from 9:00 to 15:00');
    assert.equal(cronWords('0 17-9/3 * * *'), null);
    assert.equal(cronWords('0 9-25/3 * * *'), null);
  });

  it('reads times of day and days of the week', () => {
    assert.equal(cronWords('0 4 * * *'), 'daily at 4:00');
    assert.equal(cronWords('10 3 * * *'), 'daily at 3:10');
    assert.equal(cronWords('0 9,21 * * *'), 'daily at 9:00 and 21:00');
    assert.equal(cronWords('0 0,12 * * *'), 'daily at 0:00 and 12:00');
    assert.equal(cronWords('0 9 * * 1-5'), 'weekdays at 9:00');
    assert.equal(cronWords('0 9 * * MON-FRI'), 'weekdays at 9:00');
    assert.equal(cronWords('0 10 * * 0,6'), 'weekends at 10:00');
    assert.equal(cronWords('0 10 * * 1'), 'Mondays at 10:00');
    assert.equal(cronWords('0 10 * * 7'), 'Sundays at 10:00');
    assert.equal(cronWords('0 9 * * 1,3,5'), 'Mon, Wed and Fri at 9:00');
    assert.equal(cronWords('0 23 * * 0-6'), 'daily at 23:00');
  });

  it('reads days of the month and the year', () => {
    assert.equal(cronWords('0 8 1 * *'), 'monthly on the 1st at 8:00');
    assert.equal(cronWords('30 7 22 * *'), 'monthly on the 22nd at 7:30');
    assert.equal(cronWords('0 8 13 10 *'), 'yearly on Oct 13 at 8:00');
    assert.equal(cronWords('0 8 13 oct *'), 'yearly on Oct 13 at 8:00');
  });

  it('leaves what it cannot say', () => {
    assert.equal(cronWords('0 4 * * * *'), null);
    assert.equal(cronWords('*/15 9-17 * * 1-5'), null);
    assert.equal(cronWords('0 4 1,15 * *'), null);
    assert.equal(cronWords('0 4 * * 8'), null);
    assert.equal(cronWords('60 4 * * *'), null);
    assert.equal(cronWords('0 25 * * *'), null);
    assert.equal(cronWords('0 4 32 * *'), null);
    assert.equal(cronWords('0 4 * 13 *'), null);
    assert.equal(cronWords('garbage'), null);
    assert.equal(cronWords('@daily'), null);
  });
});
