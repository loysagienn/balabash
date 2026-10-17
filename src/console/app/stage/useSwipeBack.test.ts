// The swipe back's pointer wiring over stand-ins for the DOM: which drags
// the page claims (and prevents the browser's pan for) and which it lets
// go — a drag to the left at the left edge of a wide block is the block's
// scroll, not a step back.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { installSwipeBack } from './useSwipeBack.ts';
import type { SwipeOwner } from './useSwipeBack.ts';

// A block of the page: an event target with the scroll geometry the wiring reads.
class FakeElement extends EventTarget {
  scrollLeft = 0;
  scrollWidth = 390;
  clientWidth = 390;
  parentElement: FakeElement | null = null;

  closest(): Element | null {
    return null;
  }
}

type Globals = { Element?: unknown; window?: unknown; document?: unknown; getComputedStyle?: unknown };

const globals = globalThis as Globals;
const kept: Globals = {};

function send(node: EventTarget, kind: string, props: Record<string, unknown>): Event {
  const event = new Event(kind, { cancelable: true });

  for (const [key, value] of Object.entries(props)) {
    Object.defineProperty(event, key, { value });
  }

  node.dispatchEvent(event);

  return event;
}

// A touch on `target` within `root`, then the finger at `x` 20 ms later.
function touch(root: FakeElement, target: FakeElement, x: number) {
  send(root, 'pointerdown', { target, pointerType: 'touch', isPrimary: true, button: 0, pointerId: 1, clientX: 200, clientY: 100, timeStamp: 0 });
  send(globals.window as EventTarget, 'pointermove', { pointerId: 1, clientX: x, clientY: 100, timeStamp: 20 });

  return send(root, 'touchmove', { touches: [{}] });
}

function owner(): SwipeOwner & { started: number; moves: number[]; ended: Array<[number, number]> } {
  const log = {
    started: 0,
    moves: [] as number[],
    ended: [] as Array<[number, number]>,
    canStart: () => true,
    start: () => {
      log.started += 1;

      return true;
    },
    move: (offset: number) => {
      log.moves.push(offset);
    },
    end: (velocity: number, width: number) => {
      log.ended.push([velocity, width]);
    },
    cancel: () => {},
  };

  return log;
}

describe('stage — the swipe back on the pointers', () => {
  beforeEach(() => {
    Object.assign(kept, {
      Element: globals.Element,
      window: globals.window,
      document: globals.document,
      getComputedStyle: globals.getComputedStyle,
    });
    globals.Element = FakeElement;
    globals.window = new EventTarget();
    globals.document = { activeElement: null };
    globals.getComputedStyle = () => ({ overflowX: 'auto' });
  });

  afterEach(() => {
    for (const key of ['Element', 'window', 'document', 'getComputedStyle'] as const) {
      if (kept[key] === undefined) {
        delete globals[key];
      } else {
        globals[key] = kept[key];
      }
    }
  });

  it('lets a drag to the left go: a wide block at its left edge keeps its scroll', () => {
    const root = new FakeElement();
    const block = new FakeElement();
    const page = owner();

    block.scrollWidth = 1000;
    block.parentElement = root;

    const cleanup = installSwipeBack(root as unknown as HTMLElement, page);
    const touchMove = touch(root, block, 170);

    assert.equal(page.started, 0);
    assert.equal(touchMove.defaultPrevented, false);

    // The drag is nobody's now: the finger coming back right does not claim the page either.
    send(globals.window as EventTarget, 'pointermove', { pointerId: 1, clientX: 260, clientY: 100, timeStamp: 40 });
    assert.equal(page.started, 0);
    assert.deepEqual(page.moves, []);
    cleanup();
  });

  it('claims a drag to the right, prevents the browser’s pan and reads the travel as a share of the width', () => {
    const root = new FakeElement();
    const block = new FakeElement();
    const page = owner();

    block.scrollWidth = 1000;
    block.parentElement = root;

    const cleanup = installSwipeBack(root as unknown as HTMLElement, page);
    const touchMove = touch(root, block, 230);

    assert.equal(page.started, 1);
    assert.equal(touchMove.defaultPrevented, true);

    send(globals.window as EventTarget, 'pointermove', { pointerId: 1, clientX: 269, clientY: 100, timeStamp: 40 });
    assert.deepEqual(page.moves, [0.1]);
    send(globals.window as EventTarget, 'pointerup', { pointerId: 1, clientX: 269, clientY: 100, timeStamp: 50 });
    assert.equal(page.ended.length, 1);
    assert.equal(page.ended[0]![1], 390);
    cleanup();
  });

  it('leaves a block scrolled away from its left edge its own drag', () => {
    const root = new FakeElement();
    const block = new FakeElement();
    const page = owner();

    block.scrollWidth = 1000;
    block.scrollLeft = 40;
    block.parentElement = root;

    const cleanup = installSwipeBack(root as unknown as HTMLElement, page);
    const touchMove = touch(root, block, 230);

    assert.equal(page.started, 0);
    assert.equal(touchMove.defaultPrevented, false);
    cleanup();
  });
});
