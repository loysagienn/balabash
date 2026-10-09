import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { activityChipVals } from './ActivityChip.logic.ts';

describe('activityChipVals', () => {
  it('names the count in English', () => {
    assert.deepEqual(activityChipVals(0), { quiet: true, n: 0, label: 'threads running', aria: 'All quiet' });
    assert.deepEqual(activityChipVals(1), { quiet: false, n: 1, label: 'thread running', aria: '1 thread running' });
    assert.deepEqual(activityChipVals(4), { quiet: false, n: 4, label: 'threads running', aria: '4 threads running' });
  });
});
