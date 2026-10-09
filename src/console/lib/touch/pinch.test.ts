import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PHONE_MEDIA, guardsPinch, installPinchGuard, isPinchMove } from './pinch.ts';

type Listener = (event: Event) => void;

// A stand-in for the document: records listeners, dispatches plain objects.
function fakeTarget() {
  const listeners = new Map<string, { fn: Listener; passive: boolean | undefined }[]>();

  return {
    listeners,
    count: () => [...listeners.values()].flat().length,
    addEventListener(type: string, fn: unknown, options?: unknown) {
      const list = listeners.get(type) ?? [];

      list.push({ fn: fn as Listener, passive: (options as AddEventListenerOptions | undefined)?.passive });
      listeners.set(type, list);
    },
    removeEventListener(type: string, fn: unknown) {
      listeners.set(type, (listeners.get(type) ?? []).filter(entry => entry.fn !== fn));
    },
    dispatch(type: string, event: Record<string, unknown>) {
      const prevented = { value: false };
      const synthetic = { cancelable: true, preventDefault: () => (prevented.value = true), ...event } as unknown as Event;

      for (const { fn } of listeners.get(type) ?? []) {
        fn(synthetic);
      }

      return prevented.value;
    },
  };
}

// A stand-in for window.matchMedia(PHONE_MEDIA): flips on demand, like a tablet
// gaining a trackpad or a laptop losing its mouse.
function fakeQuery(matches: boolean) {
  const changes = new Set<() => void>();

  return {
    matches,
    changes,
    addEventListener(_type: string, fn: unknown) {
      changes.add(fn as () => void);
    },
    removeEventListener(_type: string, fn: unknown) {
      changes.delete(fn as () => void);
    },
    flip(next: boolean) {
      this.matches = next;
      for (const fn of changes) {
        fn();
      }
    },
  };
}

describe('pinch guard', () => {
  it('the phone line is the primary input: a coarse pointer without hover', () => {
    assert.equal(PHONE_MEDIA, '(pointer: coarse) and (hover: none)');
  });

  it('guards only a phone with a touch screen', () => {
    assert.equal(guardsPinch({ maxTouchPoints: 5 }, true), true);
    // A touch-capable desktop: a fine primary pointer with hover — its touch pinch stays.
    assert.equal(guardsPinch({ maxTouchPoints: 10 }, false), false);
    // No touch at all: nothing to guard whatever the query says.
    assert.equal(guardsPinch({ maxTouchPoints: 0 }, true), false);
    assert.equal(guardsPinch({ maxTouchPoints: 0 }, false), false);
  });

  it('a pinch is two or more fingers moving', () => {
    assert.equal(isPinchMove(1), false);
    assert.equal(isPinchMove(2), true);
    assert.equal(isPinchMove(3), true);
  });

  it('installs nothing on a desktop without touch: the trackpad and the keyboard zoom stay', () => {
    const target = fakeTarget();
    const phone = fakeQuery(false);
    const off = installPinchGuard(target, { maxTouchPoints: 0 }, phone);

    assert.equal(target.count(), 0);
    assert.equal(phone.changes.size, 0);
    off();
  });

  it('installs nothing on a touch-capable desktop (fine primary pointer with hover): its touch pinch stays', () => {
    const target = fakeTarget();
    const phone = fakeQuery(false);
    const off = installPinchGuard(target, { maxTouchPoints: 10 }, phone);

    assert.equal(target.count(), 0);
    assert.equal(target.dispatch('gesturestart', {}), false);
    assert.equal(target.dispatch('touchmove', { touches: { length: 2 } }), false);
    off();
    assert.equal(phone.changes.size, 0);
  });

  it('cancels gesture events and multi-touch moves on a phone, with non-passive listeners', () => {
    const target = fakeTarget();
    const phone = fakeQuery(true);
    const off = installPinchGuard(target, { maxTouchPoints: 5 }, phone);

    assert.equal(target.dispatch('gesturestart', {}), true);
    assert.equal(target.dispatch('gesturechange', {}), true);
    assert.equal(target.dispatch('touchmove', { touches: { length: 2 } }), true);
    // One finger scrolls the page: untouched.
    assert.equal(target.dispatch('touchmove', { touches: { length: 1 } }), false);
    // A move the browser already committed to (not cancelable) is left alone.
    assert.equal(target.dispatch('touchmove', { touches: { length: 2 }, cancelable: false }), false);
    assert.ok([...target.listeners.values()].flat().every(entry => entry.passive === false));

    off();
    assert.equal(target.count(), 0);
    assert.equal(phone.changes.size, 0);
  });

  it('follows the query: a tablet that gains a pointer frees its pinch, a laptop that loses its mouse guards it', () => {
    const target = fakeTarget();
    const phone = fakeQuery(true);
    const off = installPinchGuard(target, { maxTouchPoints: 5 }, phone);

    assert.equal(target.dispatch('gesturestart', {}), true);

    phone.flip(false);
    assert.equal(target.count(), 0);
    assert.equal(target.dispatch('gesturestart', {}), false);

    phone.flip(true);
    assert.equal(target.dispatch('touchmove', { touches: { length: 2 } }), true);
    // The same state again installs nothing twice.
    phone.flip(true);
    assert.equal(target.count(), 3);

    off();
    assert.equal(target.count(), 0);
    assert.equal(phone.changes.size, 0);
  });
});
