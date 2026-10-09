import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { threadStateLabel } from './ThreadHead.logic.ts';

describe('threadStateLabel', () => {
  it('names the six states the way a thread reads them', () => {
    assert.equal(threadStateLabel('run'), 'running');
    assert.equal(threadStateLabel('wait'), 'awaiting message');
    assert.equal(threadStateLabel('act'), 'action needed');
    assert.equal(threadStateLabel('done'), 'completed');
    assert.equal(threadStateLabel('err'), 'crashed');
    assert.equal(threadStateLabel('off'), 'cancelled');
  });

  it('prefers an explicit label and ignores an empty one', () => {
    assert.equal(threadStateLabel('run', 'running 2h'), 'running 2h');
    assert.equal(threadStateLabel('run', ''), 'running');
  });
});
