import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { emptyFeed } from '../../store/feed/reducer.ts';
import { event, resetSeq, thread } from '../../store/fixtures.ts';
import { compactionsLabel, railSessionInfo } from './rail.ts';
import { anchorIndex, composerLock, feedScrollMove, feedStage, feedTop, threadTimeLabel } from './ThreadScreen.logic.ts';

describe('thread page words', () => {
  it('labels the header time for an active and a closed thread', () => {
    const createdAt = new Date(2026, 9, 9, 14, 2);
    const now = new Date(2026, 9, 9, 16, 38);

    assert.equal(threadTimeLabel(thread({ id: 't', createdAt }), 'run', now), 'since 14:02, running 2h 36m');
    assert.equal(threadTimeLabel(thread({ id: 't', createdAt, updatedAt: new Date(2026, 9, 9, 14, 44), status: 'completed' }), 'done', now), '14:02 → 14:44, 42m');
  });

  it('locks the composer for a finished or headless thread only', () => {
    assert.equal(composerLock(thread({ id: 't' }), false), null);
    assert.equal(composerLock(thread({ id: 't', agent: 'gardener' }), true)?.icon, 'eye-off');
    assert.equal(composerLock(thread({ id: 't', status: 'completed' }), false)?.icon, 'lock');
    assert.equal(composerLock(thread({ id: 't', status: 'failed' }), false)?.icon, 'octagon-x');
    assert.equal(composerLock(thread({ id: 't', status: 'cancelled' }), true)?.icon, 'circle-slash');
  });

  it('stages the feed body and its top line from the chunk state', () => {
    assert.equal(feedStage(emptyFeed, 0), 'skeleton');
    assert.equal(feedStage({ ...emptyFeed, request: { before: null } }, 0), 'skeleton');
    assert.equal(feedStage({ ...emptyFeed, error: { status: 0, code: 'network', message: 'x' } }, 0), 'failed');
    assert.equal(feedStage({ ...emptyFeed, knownFrom: 5n }, 0), 'ready');
    assert.equal(feedStage({ ...emptyFeed, exhausted: true }, 0), 'ready');
    assert.equal(feedStage(emptyFeed, 3), 'ready');

    assert.equal(feedTop({ ...emptyFeed, knownFrom: 5n, exhausted: true }), 'complete');
    assert.equal(feedTop({ ...emptyFeed, knownFrom: 5n, request: { before: 5n } }), 'loading');
    assert.equal(feedTop({ ...emptyFeed, knownFrom: 5n, error: { status: 0, code: 'network', message: 'x' } }), 'error');
    assert.equal(feedTop({ ...emptyFeed, knownFrom: 5n }), 'more');
  });

  it('reads the model, the final context and the compactions for the rail', () => {
    resetSeq(1n);

    const events = [
      event({ type: 'session.started', threadId: 't', payload: { model: 'claude-fable-5-1', tools: [], mcpServers: [], effort: 'high' } }),
      event({ type: 'session.context', threadId: 't', payload: { totalTokens: 120_000, maxTokens: 200_000, percentage: 60 } }),
      event({ type: 'session.compaction', threadId: 't', payload: { trigger: 'auto', preTokens: 1, postTokens: 1 } }),
      event({ type: 'session.context', threadId: 't', payload: { totalTokens: 142_000, maxTokens: 200_000, percentage: 71 } }),
    ];

    assert.deepEqual(railSessionInfo(events, null), { model: 'claude-fable-5-1', effort: 'high', context: { used: 142_000, max: 200_000 }, compactions: 1 });
    assert.deepEqual(railSessionInfo(events, { used: 150_000, max: 200_000 }).context, { used: 150_000, max: 200_000 });
    assert.equal(compactionsLabel(0), 'not compacted');
    assert.equal(compactionsLabel(1), 'compacted once');
    assert.equal(compactionsLabel(2), 'compacted twice');
    assert.equal(compactionsLabel(3), 'compacted 3 times');
  });
});

describe('feed scroll', () => {
  it('opens at the end, keeps the anchored item through an earlier chunk, follows the tail only from the end', () => {
    const seen = { knownFrom: 500n, height: 2000 };

    assert.deepEqual(feedScrollMove({ previous: null, knownFrom: null, atEnd: true, anchorShift: null, height: 900 }), { kind: 'open' });
    // An earlier chunk: by the shift of the anchored item, whatever else
    // changed height above it (the top line, re-keyed cards, opened details).
    assert.deepEqual(feedScrollMove({ previous: seen, knownFrom: 1n, atEnd: false, anchorShift: 1000, height: 3600 }), { kind: 'by', px: 1000 });
    // No measured item left in the DOM: the growth of the content.
    assert.deepEqual(feedScrollMove({ previous: seen, knownFrom: 1n, atEnd: false, anchorShift: null, height: 3000 }), { kind: 'by', px: 1000 });
    assert.equal(feedScrollMove({ previous: seen, knownFrom: 1n, atEnd: true, anchorShift: 0, height: 2000 }), null);
    // The tail (a new item or a new row inside the last group): to the end when the end was in view.
    assert.deepEqual(feedScrollMove({ previous: seen, knownFrom: 500n, atEnd: true, anchorShift: 0, height: 2100 }), { kind: 'end' });
    assert.equal(feedScrollMove({ previous: seen, knownFrom: 500n, atEnd: false, anchorShift: 0, height: 2100 }), null);
  });

  it('anchors on the item under the top of the view', () => {
    const offsets = [0, 120, 400, 900];

    assert.equal(anchorIndex(offsets, 0), 0);
    assert.equal(anchorIndex(offsets, 119), 0);
    assert.equal(anchorIndex(offsets, 400), 2);
    assert.equal(anchorIndex(offsets, 650), 2);
    assert.equal(anchorIndex(offsets, 5000), 3);
    assert.equal(anchorIndex([], 10), 0);
  });
});
