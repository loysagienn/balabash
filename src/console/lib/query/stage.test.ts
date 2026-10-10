import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { factsStage } from './stage.ts';

describe('factsStage', () => {
  it('stages a query: the skeleton, the failure, the facts — and a failed refetch over kept facts is stale, not fresh', () => {
    const facts = { scheduleTimezone: 'UTC' };
    const failure = new Error('Internal error');

    // The course of a tab: the first read in flight, its failure, Retry
    // succeeding, a refetch failing over the kept facts, Retry succeeding.
    assert.deepEqual(factsStage({ data: undefined, error: null }), { kind: 'loading' });
    assert.deepEqual(factsStage({ data: undefined, error: failure }), { kind: 'failed', error: failure });
    assert.deepEqual(factsStage({ data: facts, error: null }), { kind: 'facts', data: facts, stale: null });
    assert.deepEqual(factsStage({ data: facts, error: failure }), { kind: 'facts', data: facts, stale: failure });
    assert.deepEqual(factsStage({ data: facts, error: null }), { kind: 'facts', data: facts, stale: null });
  });
});
