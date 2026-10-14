import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { emptyFeed } from '../../store/feed/reducer.ts';
import { event, resetSeq, thread } from '../../store/fixtures.ts';
import { compactionsLabel, railSessionInfo } from './rail.ts';
import {
  anchorIndex,
  cancelWords,
  composerLock,
  FEED_OPEN_ITEMS,
  FEED_REVEAL_ITEMS,
  feedScrollMove,
  feedStage,
  feedTop,
  finishWords,
  feedWindowStart,
  isNearTop,
  nearTopAction,
  openFeedWindow,
  revealEarlier,
  settleFeedWindow,
  threadCommands,
  threadTimeLabel,
} from './ThreadScreen.logic.ts';

describe('thread page words', () => {
  it('labels the header time for an active and a closed thread', () => {
    const createdAt = new Date(2026, 9, 9, 14, 2);
    const now = new Date(2026, 9, 9, 16, 38);

    assert.equal(threadTimeLabel(thread({ id: 't', createdAt }), 'run', now), 'since 14:02, running 2h 36m');
    assert.equal(threadTimeLabel(thread({ id: 't', createdAt, updatedAt: new Date(2026, 9, 9, 14, 44), status: 'completed' }), 'done', now), '14:02 → 14:44, 42m');
  });

  it('offers the commands to an active child thread; a stop needs a turn in flight', () => {
    assert.deepEqual(threadCommands(thread({ id: 't' }), 'run'), { running: true, stopEnabled: true, remote: false, pauseEnabled: false });
    assert.deepEqual(threadCommands(thread({ id: 't' }), 'wait'), { running: true, stopEnabled: false, remote: false, pauseEnabled: false });
    assert.deepEqual(threadCommands(thread({ id: 't', status: 'completed' }), 'done'), { running: false, stopEnabled: false, remote: false, pauseEnabled: false });
    assert.deepEqual(threadCommands(thread({ id: 'main', parentId: null }), 'run'), { running: false, stopEnabled: false, remote: false, pauseEnabled: false });
    assert.deepEqual(threadCommands(thread({ id: 'r', remote: true }), 'wait'), { running: true, stopEnabled: false, remote: true, pauseEnabled: true });
    assert.deepEqual(threadCommands(thread({ id: 'r', remote: true }), 'run'), { running: true, stopEnabled: true, remote: true, pauseEnabled: false });
    assert.deepEqual(threadCommands(thread({ id: 'r', remote: true }), 'act'), { running: true, stopEnabled: false, remote: true, pauseEnabled: false });
    assert.deepEqual(threadCommands(thread({ id: 'r', remote: true }), 'paused'), { running: true, stopEnabled: false, remote: true, pauseEnabled: false });
    assert.deepEqual(threadCommands(thread({ id: 'r', remote: true, status: 'cancelled' }), 'off'), { running: false, stopEnabled: false, remote: false, pauseEnabled: false });
    assert.match(cancelWords(thread({ id: 't', agent: 'engineer' })), /^The “engineer” agent will stop/);
    assert.match(cancelWords(thread({ id: 'r', agent: 'fake_agent', remote: true })), /the “fake_agent” session itself is not touched/);
    assert.match(finishWords(thread({ id: 't', agent: 'engineer' })), /^The “engineer” agent will be asked to wrap up/);
    assert.match(finishWords(thread({ id: 'r', agent: 'fake_agent', remote: true })), /^The “fake_agent” session will be asked for a closing summary/);
  });

  it('locks the composer for a finished or headless thread only', () => {
    assert.equal(composerLock(thread({ id: 't' })), null);
    assert.equal(composerLock(thread({ id: 't', agent: 'gardener', headless: true }))?.icon, 'eye-off');
    assert.equal(composerLock(thread({ id: 't', status: 'completed' }))?.icon, 'lock');
    assert.equal(composerLock(thread({ id: 't', status: 'failed' }))?.icon, 'octagon-x');
    assert.equal(composerLock(thread({ id: 't', status: 'cancelled', headless: true }))?.icon, 'circle-slash');
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
    // An active session names its model itself, whatever the loaded events hold.
    assert.deepEqual(railSessionInfo([], null, { model: 'claude-opus-5-5', effort: null }), { model: 'claude-opus-5-5', effort: null, context: null, compactions: 0 });
    assert.equal(compactionsLabel(0), 'not compacted');
    assert.equal(compactionsLabel(1), 'compacted once');
    assert.equal(compactionsLabel(2), 'compacted twice');
    assert.equal(compactionsLabel(3), 'compacted 3 times');
  });
});

describe('feed scroll', () => {
  it('opens at the end, keeps the anchored item through a change at the top (an earlier chunk, earlier items drawn), follows the tail only from the end', () => {
    const seen = { top: '500:g500', height: 2000 };

    assert.deepEqual(feedScrollMove({ previous: null, top: ':', atEnd: true, anchorShift: null, height: 900, restore: null }), { kind: 'open' });
    // An earlier chunk: by the shift of the anchored item, whatever else
    // changed height above it (the top line, re-keyed cards, opened details).
    assert.deepEqual(feedScrollMove({ previous: seen, top: '1:g1', atEnd: false, anchorShift: 1000, height: 3600, restore: null }), { kind: 'by', px: 1000 });
    // No measured item left in the DOM: the growth of the content.
    assert.deepEqual(feedScrollMove({ previous: seen, top: '1:g1', atEnd: false, anchorShift: null, height: 3000, restore: null }), { kind: 'by', px: 1000 });
    // A reader at the end stays there, an earlier part landing included (a short feed opened before its history loaded).
    assert.deepEqual(feedScrollMove({ previous: seen, top: '1:g1', atEnd: true, anchorShift: 422, height: 1578, restore: null }), { kind: 'end' });
    assert.equal(feedScrollMove({ previous: seen, top: '1:g1', atEnd: false, anchorShift: 0, height: 2000, restore: null }), null);
    // The tail (a new item or a new row inside the last group): to the end when the end was in view.
    assert.deepEqual(feedScrollMove({ previous: seen, top: '500:g500', atEnd: true, anchorShift: 0, height: 2100, restore: null }), { kind: 'end' });
    assert.equal(feedScrollMove({ previous: seen, top: '500:g500', atEnd: false, anchorShift: 0, height: 2100, restore: null }), null);
  });

  it('opens at the place history brought back instead of the end; the place says nothing after the first view', () => {
    const seen = { top: '500:g500', height: 2000 };

    assert.deepEqual(feedScrollMove({ previous: null, top: '500:g500', atEnd: true, anchorShift: null, height: 2000, restore: 320 }), { kind: 'to', px: 320 });
    assert.deepEqual(feedScrollMove({ previous: null, top: '500:g500', atEnd: true, anchorShift: null, height: 2000, restore: 0 }), { kind: 'to', px: 0 });
    // Once open, the feed keeps its own place: a chunk and the tail as ever.
    assert.deepEqual(feedScrollMove({ previous: seen, top: '1:g1', atEnd: false, anchorShift: 700, height: 3000, restore: 320 }), { kind: 'by', px: 700 });
    assert.equal(feedScrollMove({ previous: seen, top: '500:g500', atEnd: false, anchorShift: 0, height: 2100, restore: 320 }), null);
    assert.deepEqual(feedScrollMove({ previous: seen, top: '500:g500', atEnd: true, anchorShift: 0, height: 2100, restore: 320 }), { kind: 'end' });
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

describe('feed window', () => {
  const keysOf = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => String(from + i));

  it('draws the end of a long loaded feed and fixes the window by its first item once the head chunk landed', () => {
    const keys = keysOf(0, 300);
    const open = openFeedWindow(null);

    // Before the head chunk (only the tail's items): the last items, nothing fixed.
    assert.equal(settleFeedWindow(keys, open, null, false), open);
    assert.equal(feedWindowStart(keys, open), 300 - FEED_OPEN_ITEMS);

    const fixed = settleFeedWindow(keys, open, 100n, true);

    assert.deepEqual(fixed, { key: String(300 - FEED_OPEN_ITEMS), count: FEED_OPEN_ITEMS, knownFrom: 100n });
    // Settled once: the same object after.
    assert.equal(settleFeedWindow(keys, fixed, 100n, true), fixed);
    // The tail grows at the bottom: the first drawn item stays.
    assert.equal(feedWindowStart([...keys, '300', '301'], fixed), 300 - FEED_OPEN_ITEMS);
  });

  it('draws earlier items a step at a time, down to the first loaded', () => {
    const keys = keysOf(0, 100);

    assert.deepEqual(revealEarlier(keys, { key: '70', count: 30, knownFrom: 1n }), { key: String(70 - FEED_REVEAL_ITEMS), count: 30 + FEED_REVEAL_ITEMS, knownFrom: 1n });
    assert.deepEqual(revealEarlier(keys, { key: '5', count: 95, knownFrom: 1n }), { key: '0', count: 100, knownFrom: 1n });
  });

  it('draws the next part of a chunk that lands, and stands on the count when the first item was re-keyed', () => {
    const before = keysOf(200, 260);
    const win = settleFeedWindow(before, openFeedWindow(null), 200n, true);
    const after = [...keysOf(0, 200), ...before];
    const landed = settleFeedWindow(after, win, 0n, true);

    assert.equal(feedWindowStart(after, landed), feedWindowStart(after, win) - FEED_REVEAL_ITEMS);
    assert.equal(landed.knownFrom, 0n);

    // The first drawn item merged into an older group: its key is gone.
    const rekeyed = after.filter(key => key !== win.key);

    assert.equal(feedWindowStart(rekeyed, win), rekeyed.length - win.count);
  });

  it('reveals before it loads, and loads only a feed with more history and no request or error', () => {
    const feed = { ...emptyFeed, knownFrom: 100n };

    assert.equal(nearTopAction(3, feed), 'reveal');
    assert.equal(nearTopAction(0, feed), 'load');
    assert.equal(nearTopAction(0, { ...feed, exhausted: true }), null);
    assert.equal(nearTopAction(0, { ...feed, request: { before: 100n } }), null);
    assert.equal(nearTopAction(0, { ...feed, error: { status: 500, code: 'x', message: 'x' } }), null);
    assert.equal(nearTopAction(0, emptyFeed), null);
  });

  it('is near the top within a screen above the view', () => {
    assert.equal(isNearTop(100, 56, 800), true);
    assert.equal(isNearTop(-700, 56, 800), true);
    assert.equal(isNearTop(-800, 56, 800), false);
  });
});
