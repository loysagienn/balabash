import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { segmentCount } from './counts.ts';

describe('segment counts', () => {
  const counts = { active: 3, completed: 1290, failed: 12, cancelled: 6 };

  it('takes the active ones from the store, the closed ones from the server and sums them for All', () => {
    assert.equal(segmentCount('active', counts, 4), 4);
    assert.equal(segmentCount('completed', counts, 4), 1290);
    assert.equal(segmentCount('failed', counts, 4), 12);
    assert.equal(segmentCount('cancelled', counts, 4), 6);
    assert.equal(segmentCount(undefined, counts, 4), 1312);
  });

  it('knows only the active ones before the first page', () => {
    assert.equal(segmentCount('active', null, 2), 2);
    assert.equal(segmentCount('completed', null, 2), undefined);
    assert.equal(segmentCount(undefined, null, 2), undefined);
  });
});
