// The pinch guard: the phone's two-finger zoom is off in the console
// (Vladimir's rule), the browser's zoom on a desktop — ⌘±, Ctrl+wheel, the
// menu, and the two-finger pinch on a touch-capable desktop's screen — is
// not. The declarative half is CSS — `touch-action: pan-x pan-y` on the
// root (styles/base.css) under the same media query as here — and
// `user-scalable=no` in the shell's viewport (src/api/console.ts), which a
// mobile browser honours and a desktop one never reads. iOS Safari ignores
// the viewport's user-scalable on purpose and has honoured touch-action for
// page zoom only since 13 with gaps between versions; what it has always
// honoured is the default of its own gesture events and of a multi-touch
// touchmove. This module cancels those.
//
// What "a phone" is: a device whose PRIMARY input is a finger — a coarse
// pointer that cannot hover (phones, tablets without a pointer). A desktop
// with a touch screen next to its mouse or trackpad has a fine primary
// pointer with hover (the media features describe the primary input, not
// every input), so it keeps its touch pinch as every other way to zoom; a
// Mac without touch never pinches with fingers at all. The query is live:
// a tablet that gets a trackpad or a laptop that loses its mouse moves
// across the line, and the guard follows the change.

export type TouchInput = { maxTouchPoints: number };

// The one line between a phone and a desktop, shared with styles/base.css.
export const PHONE_MEDIA = '(pointer: coarse) and (hover: none)';

export type PhoneQuery = Pick<MediaQueryList, 'matches' | 'addEventListener' | 'removeEventListener'>;

// A device without a touch screen never pinches with two fingers: nothing to
// guard, whatever the media query says.
export function guardsPinch(input: TouchInput, phone: boolean): boolean {
  return phone && input.maxTouchPoints > 0;
}

// Two or more fingers moving is a pinch (or a two-finger pan — the page pans with one).
export function isPinchMove(touchCount: number): boolean {
  return touchCount > 1;
}

type GuardTarget = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

function listen(target: GuardTarget): () => void {
  const cancel = (event: Event) => {
    if (event.cancelable) {
      event.preventDefault();
    }
  };
  const onTouchMove = (event: Event) => {
    if (isPinchMove((event as TouchEvent).touches.length)) {
      cancel(event);
    }
  };
  // iOS fires gesture* for a pinch before any zoom begins; Safari treats a
  // touchmove listener on the document as passive unless told otherwise.
  const options: AddEventListenerOptions = { passive: false };

  target.addEventListener('gesturestart', cancel, options);
  target.addEventListener('gesturechange', cancel, options);
  target.addEventListener('touchmove', onTouchMove, options);

  return () => {
    target.removeEventListener('gesturestart', cancel);
    target.removeEventListener('gesturechange', cancel);
    target.removeEventListener('touchmove', onTouchMove);
  };
}

/**
 * Cancels the pinch gestures on `target` (the document) while `phone`
 * (window.matchMedia(PHONE_MEDIA)) matches and the device has touch at all;
 * follows the query's changes. Returns the teardown. On a device without
 * touch it installs nothing.
 */
export function installPinchGuard(target: GuardTarget, input: TouchInput, phone: PhoneQuery): () => void {
  if (input.maxTouchPoints === 0) {
    return () => {};
  }

  let off: (() => void) | null = null;

  const sync = () => {
    const wanted = guardsPinch(input, phone.matches);

    if (wanted && !off) {
      off = listen(target);
    } else if (!wanted && off) {
      off();
      off = null;
    }
  };

  sync();
  phone.addEventListener('change', sync);

  return () => {
    phone.removeEventListener('change', sync);
    off?.();
    off = null;
  };
}
