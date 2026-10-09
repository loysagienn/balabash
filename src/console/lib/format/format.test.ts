import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { countOf, dayKey, dayLabel, durationLabel, rangeLabel, shortDate, sinceLabel, timeOfDay } from './index.ts';

// Local-time constructors: the helpers format in the browser's zone.
const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min);
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

  it('writes since, ranges and short dates', () => {
    assert.equal(sinceLabel(at(2026, 10, 9, 14, 2), NOW), 'since 14:02');
    assert.equal(sinceLabel(at(2026, 10, 7, 14, 2), NOW), 'since Oct 7, 14:02');
    assert.equal(sinceLabel(at(2025, 10, 7, 14, 2), NOW), 'since Oct 7, 2025, 14:02');
    assert.equal(rangeLabel(at(2026, 10, 9, 13, 17), at(2026, 10, 9, 13, 59), NOW), '13:17 → 13:59');
    assert.equal(rangeLabel(at(2026, 10, 7, 23, 10), at(2026, 10, 8, 0, 14), NOW), '23:10 → Oct 8, 00:14');
    assert.equal(shortDate(at(2026, 10, 7), NOW), 'Oct 7');
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
