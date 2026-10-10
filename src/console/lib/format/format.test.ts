import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { agoLabel, clockLabel, countOf, dateTimeLabel, dayEnd, dayKey, dayLabel, daysBefore, dayStart, durationLabel, fileSize, fileTimeLabel, folderTimeLabel, isDayKey, rangeLabel, shortDate, sinceLabel, startedLabel, timeOfDay } from './index.ts';

// Local-time constructors: the helpers format in the browser's zone.
const at = (y: number, m: number, d: number, h = 0, min = 0, sec = 0) => new Date(y, m - 1, d, h, min, sec);
const NOW = at(2026, 10, 9, 17, 30);

describe('format', () => {
  it('counts with the right plural', () => {
    assert.equal(countOf(1, 'thread'), '1 thread');
    assert.equal(countOf(1312, 'thread'), '1,312 threads');
    assert.equal(countOf(2, 'child', 'children'), '2 children');
  });

  it('writes the time of day on a 24-hour clock', () => {
    assert.equal(timeOfDay(at(2026, 10, 9, 14, 2)), '14:02');
    assert.equal(timeOfDay(at(2026, 10, 9, 0, 5)), '00:05');
  });

  it('labels days relative to now', () => {
    assert.equal(dayLabel(at(2026, 10, 9, 1), NOW), 'Today, October 9');
    assert.equal(dayLabel(at(2026, 10, 8, 23, 59), NOW), 'Yesterday, October 8');
    assert.equal(dayLabel(at(2026, 10, 5), NOW), 'Monday, October 5');
    assert.equal(dayLabel(at(2026, 10, 2), NOW), 'October 2');
    assert.equal(dayLabel(at(2025, 9, 24), NOW), 'September 24, 2025');
    assert.equal(dayKey(at(2026, 10, 9, 23)), '2026-10-09');
  });

  it('reads a day key back into its local day, ends included', () => {
    assert.equal(dayStart('2026-10-09').getTime(), at(2026, 10, 9).getTime());
    assert.equal(dayEnd('2026-10-09').getTime(), at(2026, 10, 10).getTime() - 1);
    assert.equal(dayKey(dayEnd('2026-10-31')), '2026-10-31');
    assert.equal(dayKey(daysBefore(NOW, 0)), '2026-10-09');
    assert.equal(dayKey(daysBefore(NOW, 9)), '2026-09-30');
    assert.equal(daysBefore(NOW, 1).getHours(), 0);
    assert.equal(isDayKey('2026-10-09'), true);
    assert.equal(isDayKey('2024-02-29'), true);
    assert.equal(isDayKey('2026-02-30'), false);
    assert.equal(isDayKey('2026-13-01'), false);
    assert.equal(isDayKey('2026-10-9'), false);
    assert.equal(isDayKey('2026-10-09T00:00'), false);
    assert.equal(isDayKey(''), false);
  });

  it('writes since, ranges and short dates', () => {
    assert.equal(sinceLabel(at(2026, 10, 9, 14, 2), NOW), 'since 14:02');
    assert.equal(sinceLabel(at(2026, 10, 7, 14, 2), NOW), 'since Oct 7, 14:02');
    assert.equal(sinceLabel(at(2025, 10, 7, 14, 2), NOW), 'since Oct 7, 2025, 14:02');
    assert.equal(rangeLabel(at(2026, 10, 9, 13, 17), at(2026, 10, 9, 13, 59), NOW), '13:17 → 13:59');
    assert.equal(rangeLabel(at(2026, 10, 7, 23, 10), at(2026, 10, 8, 0, 14), NOW), '23:10 → Oct 8, 00:14');
    assert.equal(shortDate(at(2026, 10, 7), NOW), 'Oct 7');
  });

  it('writes how long ago and the clock of Home', () => {
    assert.equal(agoLabel(at(2026, 10, 9, 17, 29, 40), NOW), 'just now');
    assert.equal(agoLabel(at(2026, 10, 9, 17, 23), NOW), '7 min ago');
    assert.equal(agoLabel(at(2026, 10, 9, 16, 29), NOW), '1 hour ago');
    assert.equal(agoLabel(at(2026, 10, 9, 14, 0), NOW), '3 hours ago');
    assert.equal(agoLabel(at(2026, 10, 6, 17, 0), NOW), '3 days ago');
    assert.equal(agoLabel(at(2026, 10, 1, 17, 0), NOW), 'Oct 1');
    assert.equal(agoLabel(at(2025, 10, 1, 17, 0), NOW), 'Oct 1, 2025');
    assert.equal(clockLabel(at(2026, 10, 8, 16, 38)), 'Thursday, October 8 · 16:38');
  });

  it('writes durations in the largest two units', () => {
    assert.equal(durationLabel(30_000), '<1m');
    assert.equal(durationLabel(-5), '<1m');
    assert.equal(durationLabel(22 * 60_000), '22m');
    assert.equal(durationLabel((2 * 60 + 36) * 60_000), '2h 36m');
    assert.equal(durationLabel((1 * 60 + 5) * 60_000), '1h 05m');
    assert.equal(durationLabel((3 * 24 + 4) * 3_600_000), '3d 4h');
  });
});

describe('format — feed times and sizes', () => {
  it('labels a point in time by the day and sizes in binary units', () => {
    const now = new Date(2026, 9, 9, 16, 0);

    assert.equal(dateTimeLabel(new Date(2026, 9, 9, 14, 2), now), '14:02');
    assert.equal(dateTimeLabel(new Date(2026, 9, 7, 14, 2), now), 'Oct 7, 14:02');
    assert.equal(startedLabel(new Date(2026, 9, 9, 14, 2), now), 'today, 14:02');
    assert.equal(startedLabel(new Date(2025, 9, 7, 13, 17), now), 'Oct 7, 2025, 13:17');
    assert.equal(fileSize(512), '512 B');
    assert.equal(fileSize(4300), '4.2 KiB');
    assert.equal(fileSize(60207), '59 KiB');
    assert.equal(fileSize(1.5 * 1024 * 1024), '1.5 MiB');
  });

  it('labels a file’s modified time by the day', () => {
    const now = new Date(2026, 9, 9, 16, 0);

    assert.equal(fileTimeLabel(new Date(2026, 9, 9, 16, 51), now), '16:51');
    assert.equal(fileTimeLabel(new Date(2026, 9, 8, 23, 59), now), 'yesterday');
    assert.equal(fileTimeLabel(new Date(2026, 9, 2, 9, 0), now), 'Oct 2');
    assert.equal(fileTimeLabel(new Date(2025, 9, 2, 9, 0), now), 'Oct 2, 2025');
  });

  it('labels a folder’s time by the day', () => {
    const now = new Date(2026, 9, 9, 16, 0);

    assert.equal(folderTimeLabel(new Date(2026, 9, 9, 16, 51), now), 'today');
    assert.equal(folderTimeLabel(new Date(2026, 9, 9, 0, 0), now), 'today');
    assert.equal(folderTimeLabel(new Date(2026, 9, 8, 23, 59), now), 'yesterday');
    assert.equal(folderTimeLabel(new Date(2026, 9, 2, 9, 0), now), 'Oct 2');
    assert.equal(folderTimeLabel(new Date(2025, 9, 2, 9, 0), now), 'Oct 2, 2025');
    // A day ahead of now is its date, not "today" — only the calendar day itself is.
    assert.equal(folderTimeLabel(new Date(2026, 9, 10, 0, 0), now), 'Oct 10');
    assert.equal(folderTimeLabel(new Date(2027, 0, 1, 12, 0), now), 'Jan 1, 2027');
  });
});
