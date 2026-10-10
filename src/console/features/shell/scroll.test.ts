// The restore controller over a fake box and a fake ResizeObserver: the
// place is reached as the content grows, the reader's scroll cancels it at
// once — a return to the place the last step set included — the
// controller's own steps do not, and stopping takes the listener and the
// observer with it.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { restoreScroll } from './scroll.ts';
import type { ScrollBox } from './scroll.ts';

type Listener = () => void;

// A box of a given content height in a 100 px window: scrollTop clamps as
// the browser's does, a scroll event is fired by hand — as the browser
// does, a frame after any move, the controller's own included.
function fakeBox(scrollHeight: number) {
  const listeners = new Set<Listener>();
  const child = {};
  let scrollTop = 0;
  const box = {
    get scrollTop() {
      return scrollTop;
    },
    set scrollTop(value: number) {
      scrollTop = Math.max(0, Math.min(value, box.scrollHeight - box.clientHeight));
    },
    scrollHeight,
    clientHeight: 100,
    children: [child],
    addEventListener: (type: string, listener: Listener) => {
      assert.equal(type, 'scroll');
      listeners.add(listener);
    },
    removeEventListener: (type: string, listener: Listener) => {
      assert.equal(type, 'scroll');
      listeners.delete(listener);
    },
  };
  const fire = () => listeners.forEach(listener => listener());

  return {
    box: box as unknown as ScrollBox,
    child,
    listeners,
    // The box reports its place: after the controller's step as it is, after the reader's wheel at the new place.
    report: fire,
    scrollBy: (to: number) => {
      box.scrollTop = to;
      fire();
    },
    grow: (to: number) => {
      box.scrollHeight = to;
    },
  };
}

type Observer = { callback: () => void; observed: unknown[]; disconnected: boolean };

const observers: Observer[] = [];

class FakeResizeObserver {
  private readonly record: Observer;

  constructor(callback: () => void) {
    this.record = { callback, observed: [], disconnected: false };
    observers.push(this.record);
  }

  observe(target: unknown) {
    this.record.observed.push(target);
  }

  disconnect() {
    this.record.disconnected = true;
  }
}

describe('restoreScroll — the body brought back to a history entry’s place', () => {
  beforeEach(() => {
    observers.length = 0;
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeResizeObserver;
  });

  afterEach(() => {
    delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  });

  it('is done at once when the content is tall enough: nothing watched, nothing listened to', () => {
    const { box, listeners } = fakeBox(1000);
    const stop = restoreScroll(box, 300);

    assert.equal(box.scrollTop, 300);
    assert.equal(observers.length, 0);
    assert.equal(listeners.size, 0);
    stop();
  });

  it('goes as far as the content allows and the rest as it grows; its own steps are no move', () => {
    const { box, child, listeners, report, grow } = fakeBox(300);
    const stop = restoreScroll(box, 600);

    assert.equal(box.scrollTop, 200);
    assert.equal(observers.length, 1);
    assert.deepEqual(observers[0]!.observed, [child]);
    assert.equal(listeners.size, 1);

    // The box reports the step; the controller keeps waiting.
    report();
    assert.equal(observers[0]!.disconnected, false);
    assert.equal(listeners.size, 1);

    grow(500);
    observers[0]!.callback();
    assert.equal(box.scrollTop, 400);
    report();
    assert.equal(listeners.size, 1);

    grow(1100);
    observers[0]!.callback();
    assert.equal(box.scrollTop, 600);
    assert.equal(observers[0]!.disconnected, true);
    assert.equal(listeners.size, 0);
    stop();
  });

  it('is cancelled by the reader’s scroll at once, a return to the last step’s place before any growth included', () => {
    const { box, listeners, scrollBy, grow } = fakeBox(300);

    restoreScroll(box, 600);
    assert.equal(box.scrollTop, 200);

    // The reader scrolls up to read, then back to the end of what there is; no growth between.
    scrollBy(100);
    assert.equal(observers[0]!.disconnected, true);
    assert.equal(listeners.size, 0);
    scrollBy(200);

    // The content arrives: the box is the reader's, the old target does not move it.
    grow(1100);
    observers[0]!.callback();
    assert.equal(box.scrollTop, 200);
  });

  it('is cancelled by the screen’s own hand on the box, the growth it sees after notwithstanding', () => {
    const { box, listeners, scrollBy, grow } = fakeBox(300);

    restoreScroll(box, 600);
    // The feed opened at its own place, the move noticed at the next growth only.
    box.scrollTop = 0;
    grow(1100);
    observers[0]!.callback();
    assert.equal(box.scrollTop, 0);
    assert.equal(observers[0]!.disconnected, true);
    assert.equal(listeners.size, 0);
    scrollBy(50);
    assert.equal(box.scrollTop, 50);
  });

  it('takes a fraction of a pixel as the same place', () => {
    const { box, listeners, grow } = fakeBox(300);

    restoreScroll(box, 600);
    (box as { scrollTop: number }).scrollTop = 200.4;
    listeners.forEach(listener => listener());
    assert.equal(observers[0]!.disconnected, false);
    grow(1100);
    observers[0]!.callback();
    assert.equal(box.scrollTop, 600);
  });

  it('stops with the effect: the listener and the observer go, a later growth moves nothing', () => {
    const { box, listeners, grow } = fakeBox(300);
    const stop = restoreScroll(box, 600);

    stop();
    assert.equal(observers[0]!.disconnected, true);
    assert.equal(listeners.size, 0);
    grow(1100);
    observers[0]!.callback();
    assert.equal(box.scrollTop, 200);
    stop();
    assert.equal(listeners.size, 0);
  });
});
