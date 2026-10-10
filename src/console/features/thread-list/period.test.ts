import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { periodLabel, periodPreset, presetPeriod, samePeriod } from './period.ts';

const at = (y: number, m: number, d: number, h = 0) => new Date(y, m - 1, d, h);
const NOW = at(2026, 10, 9, 17);

describe('threads period', () => {
  it('turns a preset into the days of this moment', () => {
    assert.deepEqual(presetPeriod('today', NOW), { from: '2026-10-09' });
    assert.deepEqual(presetPeriod('yesterday', NOW), { from: '2026-10-08', to: '2026-10-08' });
    assert.deepEqual(presetPeriod('7d', NOW), { from: '2026-10-03' });
    assert.deepEqual(presetPeriod('30d', NOW), { from: '2026-09-10' });
    // Across a month and a year.
    assert.deepEqual(presetPeriod('7d', at(2026, 1, 3)), { from: '2025-12-28' });
    assert.deepEqual(presetPeriod('30d', at(2026, 3, 1)), { from: '2026-01-31' });
  });

  it('recognizes a preset only while the days are its days', () => {
    assert.equal(periodPreset({ from: '2026-10-09' }, NOW), 'today');
    assert.equal(periodPreset({ from: '2026-10-08', to: '2026-10-08' }, NOW), 'yesterday');
    assert.equal(periodPreset({ from: '2026-10-03' }, NOW), '7d');
    // The same days a day later are a date, not the preset.
    assert.equal(periodPreset({ from: '2026-10-09' }, at(2026, 10, 10)), undefined);
    assert.equal(periodPreset({ from: '2026-10-09', to: '2026-10-09' }, NOW), undefined);
    assert.equal(periodPreset({}, NOW), undefined);
    assert.equal(samePeriod({ from: '2026-10-09', to: undefined }, { from: '2026-10-09' }), true);
  });

  it('names the period', () => {
    assert.equal(periodLabel({}, NOW), undefined);
    assert.equal(periodLabel({ from: '2026-10-09' }, NOW), 'Today');
    assert.equal(periodLabel({ from: '2026-10-08', to: '2026-10-08' }, NOW), 'Yesterday');
    assert.equal(periodLabel({ from: '2026-10-03' }, NOW), 'Last 7 days');
    assert.equal(periodLabel({ from: '2026-09-10' }, NOW), 'Last 30 days');
    assert.equal(periodLabel({ from: '2026-10-01', to: '2026-10-09' }, NOW), 'Oct 1 – Oct 9');
    assert.equal(periodLabel({ from: '2026-10-09', to: '2026-10-09' }, NOW), 'Oct 9');
    assert.equal(periodLabel({ from: '2026-10-09' }, at(2026, 10, 10)), 'since Oct 9');
    assert.equal(periodLabel({ to: '2025-12-31' }, NOW), 'until Dec 31, 2025');
  });
});
