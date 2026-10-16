import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { KEYBOARD_ATTR, KEYBOARD_MIN_PX, RECHECK_DELAYS_MS, installKeyboardWatch, isTextEntry, keyboardShown } from './keyboard.ts';

type Listener = () => void;

function listeners() {
  const map = new Map<string, Set<Listener>>();

  return {
    map,
    count: () => [...map.values()].reduce((n, set) => n + set.size, 0),
    addEventListener(type: string, fn: unknown) {
      const set = map.get(type) ?? new Set<Listener>();

      set.add(fn as Listener);
      map.set(type, set);
    },
    removeEventListener(type: string, fn: unknown) {
      map.get(type)?.delete(fn as Listener);
    },
    fire(type: string) {
      for (const fn of map.get(type) ?? []) {
        fn();
      }
    },
  };
}

// A stand-in for window with its visual viewport: the sizes change on demand
// and the viewport reports a resize, as the keyboard sliding out or away.
function fakeWindow(height: number, scale = 1) {
  const vp = listeners();
  const w = listeners();
  const viewport = { height, scale, addEventListener: vp.addEventListener, removeEventListener: vp.removeEventListener };
  const win = {
    visualViewport: viewport,
    addEventListener: w.addEventListener as Window['addEventListener'],
    removeEventListener: w.removeEventListener as Window['removeEventListener'],
    count: () => vp.count() + w.count(),
    // The keyboard: the visual viewport shrinks, its resize fires (unless the browser skips it).
    resize(next: number, nextScale = scale, fire = true) {
      viewport.height = next;
      viewport.scale = nextScale;
      if (fire) {
        vp.fire('resize');
      }
    },
  };

  return win;
}

// A stand-in for the document: the root's attributes, the focused element, focusin/focusout.
function fakeDocument() {
  const d = listeners();
  const attrs = new Map<string, string>();
  const doc = {
    documentElement: {
      setAttribute(name: string, value: string) {
        attrs.set(name, value);
      },
      removeAttribute(name: string) {
        attrs.delete(name);
      },
    },
    activeElement: null as { tagName: string; type?: string } | null,
    addEventListener: d.addEventListener as Document['addEventListener'],
    removeEventListener: d.removeEventListener as Document['removeEventListener'],
    marked: () => attrs.has(KEYBOARD_ATTR),
    count: d.count,
    focus(el: { tagName: string; type?: string } | null) {
      doc.activeElement = el;
      d.fire(el ? 'focusin' : 'focusout');
    },
  };

  return doc;
}

// Timers that run when told: queued callbacks with their delays.
function fakeTimers() {
  const queue = new Map<number, { fn: () => void; ms: number }>();
  let seq = 0;

  return {
    queue,
    setTimeout(fn: () => void, ms: number) {
      queue.set(++seq, { fn, ms });
      return seq;
    },
    clearTimeout(id: unknown) {
      queue.delete(id as number);
    },
    // Runs every queued callback up to and including `ms`.
    run(ms: number) {
      for (const [id, entry] of [...queue].sort((a, b) => a[1].ms - b[1].ms)) {
        if (entry.ms <= ms) {
          queue.delete(id);
          entry.fn();
        }
      }
    },
  };
}

const TEXTAREA = { tagName: 'TEXTAREA' };

describe('on-screen keyboard watch', () => {
  it('a keyboard is a focused text field with the visual viewport lower than the free one by at least its minimum, at scale 1', () => {
    const off = { shown: false };

    // An iPhone 15 in a home-screen web app: the free viewport is 852, the keyboard takes ~336.
    assert.equal(keyboardShown({ ...off, focused: true, freeHeight: 852, visualHeight: 516, scale: 1 }), true);
    assert.equal(keyboardShown({ ...off, focused: true, freeHeight: 852, visualHeight: 852, scale: 1 }), false);
    // No field focused: the viewport alone does not let the state in.
    assert.equal(keyboardShown({ ...off, focused: false, freeHeight: 852, visualHeight: 516, scale: 1 }), false);
    // The threshold itself counts; a pixel less does not.
    assert.equal(keyboardShown({ ...off, focused: true, freeHeight: 852, visualHeight: 852 - KEYBOARD_MIN_PX, scale: 1 }), true);
    assert.equal(keyboardShown({ ...off, focused: true, freeHeight: 852, visualHeight: 852 - KEYBOARD_MIN_PX + 1, scale: 1 }), false);
    // A pinch zoom shrinks the visual viewport as well — with a scale above 1: not a keyboard.
    assert.equal(keyboardShown({ ...off, focused: true, freeHeight: 852, visualHeight: 426, scale: 2 }), false);
    // A browser's own fractional scale (1.0000001) still counts as 1.
    assert.equal(keyboardShown({ ...off, focused: true, freeHeight: 852, visualHeight: 516, scale: 1.001 }), true);
  });

  it('the state already on stays with the blur and goes with the viewport coming back', () => {
    const on = { shown: true, freeHeight: 852, scale: 1 };

    // The field blurred (a tap on Send), the keyboard still out: on.
    assert.equal(keyboardShown({ ...on, focused: false, visualHeight: 516 }), true);
    // The keyboard gone: off, focused or not.
    assert.equal(keyboardShown({ ...on, focused: false, visualHeight: 852 }), false);
    assert.equal(keyboardShown({ ...on, focused: true, visualHeight: 852 }), false);
  });

  it('a text entry is a textarea, an input that takes text, or an editable element', () => {
    assert.equal(isTextEntry(TEXTAREA), true);
    assert.equal(isTextEntry({ tagName: 'input' }), true);
    assert.equal(isTextEntry({ tagName: 'INPUT', type: 'search' }), true);
    assert.equal(isTextEntry({ tagName: 'INPUT', type: 'email' }), true);
    assert.equal(isTextEntry({ tagName: 'INPUT', type: 'checkbox' }), false);
    assert.equal(isTextEntry({ tagName: 'INPUT', type: 'file' }), false);
    assert.equal(isTextEntry({ tagName: 'BUTTON' }), false);
    assert.equal(isTextEntry({ tagName: 'DIV', isContentEditable: true }), true);
    assert.equal(isTextEntry({ tagName: 'DIV' }), false);
    assert.equal(isTextEntry(null), false);
    assert.equal(isTextEntry(undefined), false);
  });

  it('installs nothing without a visual viewport', () => {
    const doc = fakeDocument();
    const win = { ...fakeWindow(852), visualViewport: null };
    const off = installKeyboardWatch(doc, win, fakeTimers());

    assert.equal(doc.marked(), false);
    assert.equal(doc.count(), 0);
    off();
  });

  it('marks the root while the keyboard is out and clears the mark when it goes away', () => {
    const doc = fakeDocument();
    const win = fakeWindow(852);
    const timers = fakeTimers();
    const off = installKeyboardWatch(doc, win, timers);

    assert.equal(doc.marked(), false);

    doc.focus(TEXTAREA);
    // The field is focused, the keyboard still sliding: not yet.
    assert.equal(doc.marked(), false);
    win.resize(516);
    assert.equal(doc.marked(), true);

    // The keyboard changes its height (a suggestion strip, emoji): still out.
    win.resize(480);
    assert.equal(doc.marked(), true);

    win.resize(852);
    doc.focus(null);
    assert.equal(doc.marked(), false);

    off();
    assert.equal(win.count(), 0);
    assert.equal(doc.count(), 0);
    assert.equal(timers.queue.size, 0);
  });

  it('a missed resize: the state is re-read along the slide after a focus change', () => {
    const doc = fakeDocument();
    const win = fakeWindow(852);
    const timers = fakeTimers();
    const off = installKeyboardWatch(doc, win, timers);

    doc.focus(TEXTAREA);
    assert.equal(timers.queue.size, RECHECK_DELAYS_MS.length);
    // The viewport shrinks without an event.
    win.resize(516, 1, false);
    assert.equal(doc.marked(), false);
    timers.run(300);
    assert.equal(doc.marked(), true);

    // The keyboard goes away without an event too; the blur's re-checks catch it.
    win.resize(852, 1, false);
    doc.focus(null);
    assert.equal(doc.marked(), false);
    off();
  });

  it('a tap on Send: the blur alone keeps the mark (the click must land on a button that has not moved), the viewport coming back clears it', () => {
    const doc = fakeDocument();
    const win = fakeWindow(852);
    const timers = fakeTimers();
    const off = installKeyboardWatch(doc, win, timers);

    doc.focus(TEXTAREA);
    win.resize(516);
    assert.equal(doc.marked(), true);

    // The field blurs on the tap; the keyboard only starts sliding away. The click comes next — the bar must not move.
    doc.focus(null);
    assert.equal(doc.marked(), true);
    timers.run(150);
    assert.equal(doc.marked(), true);

    // The keyboard is gone (its resize, or a re-check seeing the height): the mark goes, and only now.
    win.resize(852);
    assert.equal(doc.marked(), false);

    // The free height was not taken from the shrunken viewport along the way: the next keyboard is detected as before.
    doc.focus(TEXTAREA);
    win.resize(516);
    assert.equal(doc.marked(), true);
    off();
  });

  it('the focus moving between fields keeps the mark; a hardware keyboard never sets it', () => {
    const doc = fakeDocument();
    const win = fakeWindow(852);
    const timers = fakeTimers();
    const off = installKeyboardWatch(doc, win, timers);

    doc.focus(TEXTAREA);
    win.resize(516);
    assert.equal(doc.marked(), true);
    // Another field: iOS fires no resize, the viewport stays low.
    doc.focus({ tagName: 'INPUT', type: 'text' });
    timers.run(800);
    assert.equal(doc.marked(), true);

    win.resize(852);
    doc.focus(null);
    assert.equal(doc.marked(), false);

    // A hardware keyboard: focused, nothing slides out.
    doc.focus(TEXTAREA);
    timers.run(800);
    assert.equal(doc.marked(), false);
    off();
  });

  it('the free height follows the viewport while no field is focused: a turn of the phone is not a keyboard', () => {
    const doc = fakeDocument();
    const win = fakeWindow(852);
    const off = installKeyboardWatch(doc, win, fakeTimers());

    // Landscape: the viewport is 393 high with nothing focused.
    win.resize(393);
    doc.focus(TEXTAREA);
    assert.equal(doc.marked(), false);
    win.resize(200);
    assert.equal(doc.marked(), true);
    off();
    assert.equal(doc.marked(), false);
  });

  it('a pinch zoom is not a keyboard', () => {
    const doc = fakeDocument();
    const win = fakeWindow(852);
    const off = installKeyboardWatch(doc, win, fakeTimers());

    doc.focus(TEXTAREA);
    win.resize(426, 2);
    assert.equal(doc.marked(), false);
    off();
  });
});
