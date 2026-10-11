import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { factsStage, heldFailure } from './stage.ts';

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

describe('heldFailure', () => {
  it('keeps the failure shown before through a refetch without data, and lets the fetch’s outcome replace it', () => {
    const failure = new Error('404');
    const other = new Error('500');

    // The first read: nothing held, nothing failed yet.
    assert.equal(heldFailure(null, { data: undefined, error: null, isFetching: true }), null);
    // It failed; the next poll starts — Query clears the error, the card keeps it.
    assert.equal(heldFailure(null, { data: undefined, error: failure, isFetching: false }), failure);
    assert.equal(heldFailure(failure, { data: undefined, error: null, isFetching: true }), failure);
    // The poll fails otherwise — its own error; or brings data — no failure.
    assert.equal(heldFailure(failure, { data: undefined, error: other, isFetching: false }), other);
    assert.equal(heldFailure(failure, { data: { ok: true }, error: null, isFetching: false }), null);
    // A refetch over data with a held error from before: not a failure anymore.
    assert.equal(heldFailure(failure, { data: { ok: true }, error: null, isFetching: true }), null);
  });
});
