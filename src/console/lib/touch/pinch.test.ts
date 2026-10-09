import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { guardsPinch, installPinchGuard, isPinchMove } from './pinch.ts';

type Listener = (event: Event) => void;

// A stand-in for the document: records listeners, dispatches plain objects.
function fakeTarget() {
  const listeners = new Map<string, { fn: Listener; passive: boolean | undefined }[]>();

  return {
    listeners,
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

describe('pinch guard', () => {
  it('guards only a device with a touch screen', () => {
    assert.equal(guardsPinch({ maxTouchPoints: 5 }), true);
    assert.equal(guardsPinch({ maxTouchPoints: 0 }), false);
  });

  it('a pinch is two or more fingers moving', () => {
    assert.equal(isPinchMove(1), false);
    assert.equal(isPinchMove(2), true);
    assert.equal(isPinchMove(3), true);
  });

  it('installs nothing on a desktop without touch: the trackpad and the keyboard zoom stay', () => {
    const target = fakeTarget();
    const off = installPinchGuard(target, { maxTouchPoints: 0 });

    assert.equal(target.listeners.size, 0);
    off();
  });

  it('cancels gesture events and multi-touch moves on a touch device, with non-passive listeners', () => {
    const target = fakeTarget();
    const off = installPinchGuard(target, { maxTouchPoints: 5 });

    assert.equal(target.dispatch('gesturestart', {}), true);
    assert.equal(target.dispatch('gesturechange', {}), true);
    assert.equal(target.dispatch('touchmove', { touches: { length: 2 } }), true);
    // One finger scrolls the page: untouched.
    assert.equal(target.dispatch('touchmove', { touches: { length: 1 } }), false);
    // A move the browser already committed to (not cancelable) is left alone.
    assert.equal(target.dispatch('touchmove', { touches: { length: 2 }, cancelable: false }), false);
    assert.ok([...target.listeners.values()].flat().every(entry => entry.passive === false));

    off();
    assert.ok([...target.listeners.values()].every(list => list.length === 0));
  });
});
