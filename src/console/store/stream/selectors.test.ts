import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { snapshotStage } from './selectors.ts';

describe('snapshot stage', () => {
  it('tells the stage of a snapshot-only screen from the stream', () => {
    assert.equal(snapshotStage({ asOfSeq: null, snapshot: { pending: true, error: null } }), 'loading');
    assert.equal(snapshotStage({ asOfSeq: null, snapshot: { pending: false, error: null } }), 'loading');
    assert.equal(snapshotStage({ asOfSeq: null, snapshot: { pending: false, error: { message: 'down' } } }), 'failed');
    assert.equal(snapshotStage({ asOfSeq: null, snapshot: { pending: true, error: { message: 'down' } } }), 'loading');
    assert.equal(snapshotStage({ asOfSeq: 10n, snapshot: { pending: false, error: null } }), 'ready');
  });
});
