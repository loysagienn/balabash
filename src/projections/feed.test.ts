import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { feedScope, feedThreadIds } from './feed.ts';

describe('feedScope', () => {
  it('admits the author and the addressee, nobody else', () => {
    const event = { threadId: 'child', targetThreadId: 'parent' };

    assert.equal(feedScope(event, 'child'), true);
    assert.equal(feedScope(event, 'parent'), true);
    assert.equal(feedScope(event, 'other'), false);
    assert.equal(feedScope({ threadId: null, targetThreadId: null }, 'child'), false);
  });
});

describe('feedThreadIds', () => {
  it('lists each thread once', () => {
    assert.deepEqual(feedThreadIds({ threadId: 'a', targetThreadId: 'b' }), ['a', 'b']);
    assert.deepEqual(feedThreadIds({ threadId: 'a', targetThreadId: null }), ['a']);
    assert.deepEqual(feedThreadIds({ threadId: null, targetThreadId: 'b' }), ['b']);
    assert.deepEqual(feedThreadIds({ threadId: 'a', targetThreadId: 'a' }), ['a']);
  });
});
