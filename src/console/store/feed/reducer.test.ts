import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { insertSeq } from './reducer.ts';

describe('insertSeq', () => {
  it('keeps the list ascending and unique, returning the same array when nothing changes', () => {
    const seqs = insertSeq(insertSeq(insertSeq([], 5n), 2n), 9n);

    assert.deepEqual(seqs, ['2', '5', '9']);
    assert.equal(insertSeq(seqs, 5n), seqs);
    assert.deepEqual(insertSeq(seqs, 7n), ['2', '5', '7', '9']);
    assert.deepEqual(insertSeq(seqs, 1n), ['1', '2', '5', '9']);
  });
});
