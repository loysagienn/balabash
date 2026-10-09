// The pinch guard: the phone's two-finger zoom is off in the console
// (Vladimir's rule), the desktop browser's zoom (⌘±, Ctrl+wheel, the menu)
// is not. The declarative half is CSS — `touch-action: pan-x pan-y` on the
// root (styles/base.css) and `user-scalable=no` in the shell's viewport
// (src/api/console.ts) — honoured by Chrome and Firefox on Android. iOS
// Safari ignores the viewport's user-scalable on purpose and has honoured
// touch-action for page zoom only since 13 with gaps between versions; what
// it has always honoured is the default of its own gesture events and of a
// multi-touch touchmove. This module cancels those — only on a device that
// has touch at all, so a Mac's trackpad pinch (gesture events in desktop
// Safari, Ctrl+wheel elsewhere) and every keyboard zoom stay what they are.

export type TouchInput = { maxTouchPoints: number };

// A device without a touch screen never pinches with two fingers: nothing to guard.
export function guardsPinch(input: TouchInput): boolean {
  return input.maxTouchPoints > 0;
}

// Two or more fingers moving is a pinch (or a two-finger pan — the page pans with one).
export function isPinchMove(touchCount: number): boolean {
  return touchCount > 1;
}

type GuardTarget = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

/**
 * Cancels the pinch gestures of a touch device on `target` (the document).
 * Returns the teardown. On a device without touch it installs nothing.
 */
export function installPinchGuard(target: GuardTarget, input: TouchInput): () => void {
  if (!guardsPinch(input)) {
    return () => {};
  }

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
