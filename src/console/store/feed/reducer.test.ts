import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { eventAction } from '../events.ts';
import { event, resetSeq } from '../fixtures.ts';
import { loadThreadEvents, loadThreadEventsDone } from '../threads/actions.ts';
import { evictFeeds } from './actions.ts';
import { feedReducer, initialFeed, insertSeq } from './reducer.ts';
import type { FeedState } from './reducer.ts';

describe('insertSeq', () => {
  it('keeps the list ascending and unique, returning the same array when nothing changes', () => {
    const seqs = insertSeq(insertSeq(insertSeq([], 5n), 2n), 9n);

    assert.deepEqual(seqs, ['2', '5', '9']);
    assert.equal(insertSeq(seqs, 5n), seqs);
    assert.deepEqual(insertSeq(seqs, 7n), ['2', '5', '7', '9']);
    assert.deepEqual(insertSeq(seqs, 1n), ['1', '2', '5', '9']);
  });
});

describe('FEED_EVICT', () => {
  // Three threads of one tail: a child reporting to the main thread (its
  // start and end are in both feeds), a sibling with its own events, and
  // the main thread's own event.
  function loaded(): FeedState {
    resetSeq(10n);

    const events = [
      event({ type: 'thread.started', threadId: 'child', targetThreadId: 'main', payload: { agent: 'engineer' } }),
      event({ type: 'thread.progress', threadId: 'child', payload: { text: 'working' } }),
      event({ type: 'thread.completed', threadId: 'child', targetThreadId: 'main', payload: { summary: { text: 'done' } } }),
      event({ type: 'thread.progress', threadId: 'sibling', payload: { text: 'still at it' } }),
      event({ type: 'user.message', actor: 'user', threadId: 'main', payload: { text: 'hi' } }),
    ];

    return events.reduce((state, item) => feedReducer(state, eventAction(item)), initialFeed);
  }

  it('takes the thread out with its events, keeping the ones another feed still shows', () => {
    const before = loaded();

    assert.deepEqual(before.byThread.child.seqs, ['10', '11', '12']);
    assert.deepEqual(before.byThread.main.seqs, ['10', '12', '14']);
    assert.deepEqual(Object.keys(before.events).sort(), ['10', '11', '12', '13', '14']);

    const after = feedReducer(before, evictFeeds(['child']));

    assert.equal(after.byThread.child, undefined);
    // The start and the end are the main thread's too; the progress was the child's alone.
    assert.deepEqual(Object.keys(after.events).sort(), ['10', '12', '13', '14']);
    assert.equal(after.byThread.main, before.byThread.main);
    assert.equal(after.byThread.sibling, before.byThread.sibling);
  });

  it('takes several threads at once, and the events shared only among them go too', () => {
    const before = loaded();
    const after = feedReducer(before, evictFeeds(['child', 'main']));

    assert.deepEqual(Object.keys(after.byThread), ['sibling']);
    assert.deepEqual(Object.keys(after.events), ['13']);
  });

  it('is nothing for a thread the store has no feed of', () => {
    const before = loaded();

    assert.equal(feedReducer(before, evictFeeds(['nobody'])), before);
    assert.equal(feedReducer(before, evictFeeds([])), before);
  });

  it('keeps a shared event only while a kept feed really lists it: a feed brought back in part does not hold what it lacks', () => {
    // The child evicted, then opened again with a chunk from the head that
    // reaches only its end (seq 12): its start (seq 10) is the main feed's
    // alone now. The main feed evicted: the start goes with it — the
    // child's feed exists, but does not list it — while the end stays with
    // the child. The child evicted again: nothing is left behind.
    const evicted = feedReducer(loaded(), evictFeeds(['child']));
    const requested = feedReducer(evicted, loadThreadEvents('child', null));
    const partial = feedReducer(requested, loadThreadEventsDone('child', null, [evicted.events['12']], 12n));

    assert.deepEqual(partial.byThread.child.seqs, ['12']);
    assert.deepEqual(partial.byThread.main.seqs, ['10', '12', '14']);

    const mainGone = feedReducer(partial, evictFeeds(['main']));

    assert.deepEqual(Object.keys(mainGone.events).sort(), ['12', '13']);

    const childGone = feedReducer(mainGone, evictFeeds(['child']));

    assert.deepEqual(Object.keys(childGone.events), ['13']);

    // The same with the child's feed started afresh by a late frame of the
    // tail: the frame alone is the child's, the shared start and end are not.
    const late = feedReducer(evicted, eventAction(event({ type: 'session.state', threadId: 'child', payload: { state: 'wait' } })));
    const afterMain = feedReducer(late, evictFeeds(['main']));

    assert.deepEqual(Object.keys(afterMain.events).sort(), ['13', '15']);
    assert.deepEqual(Object.keys(feedReducer(afterMain, evictFeeds(['child'])).events), ['13']);
  });

  it('leaves an evicted thread as never loaded: the next frame of the tail starts its feed afresh', () => {
    const evicted = feedReducer(loaded(), evictFeeds(['child']));
    const late = event({ type: 'session.state', threadId: 'child', payload: { state: 'wait' } });
    const after = feedReducer(evicted, eventAction(late));

    assert.deepEqual(after.byThread.child, { seqs: [late.seq.toString()], knownFrom: null, exhausted: false, request: null, error: null });
  });
});
