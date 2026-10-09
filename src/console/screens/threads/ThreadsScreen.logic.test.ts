import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ThreadsListState } from '../../store/threads/reducer.ts';
import { emptyMatchNote, threadsBody, threadsFoot } from './ThreadsScreen.logic.ts';

const filters = { status: null, projectId: null, agent: null, q: null };
const list = (partial: Partial<ThreadsListState>): ThreadsListState => ({ ids: [], nextCursor: null, loading: false, filters, error: null, counts: null, countsAsOfSeq: null, ...partial });
const failure = { status: 0, code: 'network', message: 'offline' };

describe('Threads screen body', () => {
  it('reads the stage of the first page from the request, not from the visible rows', () => {
    assert.equal(threadsBody(list({ filters: null }), 0), 'skeleton');
    assert.equal(threadsBody(list({ loading: true }), 0), 'skeleton');
    // The snapshot's threads would match, but no page of this set has landed.
    assert.equal(threadsBody(list({ error: failure }), 3), 'failed');
    // Retry after a failure: back to the skeleton.
    assert.equal(threadsBody(list({ error: null, loading: true }), 0), 'skeleton');
    // An empty first page is a real, exhausted answer.
    assert.equal(threadsBody(list({}), 0), 'empty');
    assert.equal(threadsBody(list({ ids: ['a'] }), 1), 'rows');
  });

  it('keeps the empty state while the loaded range has no rows', () => {
    assert.equal(threadsBody(list({ ids: ['a'], nextCursor: 51n }), 0), 'empty');
    assert.equal(threadsBody(list({ ids: ['a'], nextCursor: 51n, loading: true }), 0), 'empty');
    assert.equal(threadsBody(list({ ids: ['a'], error: failure }), 0), 'empty');
  });

  it('offers the remaining pages and a failed page under the rows and under the empty state alike', () => {
    assert.equal(threadsFoot(list({ ids: ['a'], nextCursor: 51n })), 'more');
    assert.equal(threadsFoot(list({ ids: ['a'], nextCursor: 51n, error: failure })), 'retry');
    assert.equal(threadsFoot(list({ ids: ['a'] })), null);
    assert.match(emptyMatchNote('more'), /loading/);
    assert.match(emptyMatchNote('retry'), /could not be loaded/);
    assert.match(emptyMatchNote(null), /whole list/);
  });
});
