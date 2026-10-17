// The swipe back on the phone wired to the pointers (the rules: lib/gesture
// and stage.logic.ts). A touch (or a pen) anywhere on the current page
// starts a drag; the drag is claimed when it turns out horizontal
// (lib/gesture/drag — the slop, the axis) and let go when vertical: the
// page's own scroll, which the browser starts on its own and reports with
// a pointercancel. A step back is a drag to the right: a horizontal drag
// to the left is let go too — the page would not move, and the browser
// keeps the drag for what is under the finger (a wide block at its left
// edge scrolls on). From the claim on, the touch's moves are prevented
// (a non-passive touchmove listener: the root allows pan-x pan-y to every
// block, so a horizontal scroller inside keeps its scroll — a drag that
// starts on one that can still scroll to the left is its own, not the
// page's), the focused field loses the focus (the keyboard leaves before
// the page moves, not in the middle of the motion), and the page follows
// the finger: the travel as a share of the width. The lift settles it
// (stage.logic: the velocity and the place decide); a second finger or
// the browser taking the touch sends it back.

import { Drag } from '../../lib/gesture/drag.ts';

export type SwipeOwner = {
  // Whether a drag may start on this target now (the phone, a nested page,
  // nothing under the finger that owns horizontal moves).
  canStart(target: Element): boolean;
  // The drag is horizontal: the page is claimed (false — not after all).
  start(): boolean;
  move(offset: number): void;
  end(velocity: number, width: number): void;
  cancel(): void;
};

// What is never the page's to swipe: a widget that says so, a slider, the image viewer.
const OWN_HORIZONTAL = '[data-swipe="off"], input[type="range"], .lbox';

// A block between the target and the root that scrolls sideways and has
// room to scroll back: the drag to the right is its own.
export function ownsRightwardDrag(target: Element, root: Element): boolean {
  if (target.closest(OWN_HORIZONTAL)) {
    return true;
  }

  for (let element: Element | null = target; element && element !== root; element = element.parentElement) {
    if (element.scrollLeft > 0 && element.scrollWidth > element.clientWidth + 1) {
      const overflow = getComputedStyle(element).overflowX;

      if (overflow === 'auto' || overflow === 'scroll') {
        return true;
      }
    }
  }

  return false;
}

export function installSwipeBack(root: HTMLElement, owner: SwipeOwner): () => void {
  let drag: Drag | null = null;
  let pointerId = -1;
  let claimed = false;
  let width = 1;

  const teardown = () => {
    drag = null;
    claimed = false;
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
    root.removeEventListener('touchmove', onTouchMove);
  };

  const onMove = (event: PointerEvent) => {
    if (!drag || event.pointerId !== pointerId) {
      return;
    }

    const move = drag.move(event.clientX, event.clientY, event.timeStamp);

    switch (move.kind) {
      case 'claim':
        if (move.sign < 0 || !owner.start()) {
          teardown();
          return;
        }

        claimed = true;
        (document.activeElement as HTMLElement | null)?.blur?.();
        return;
      case 'move':
        owner.move(move.travel / width);
        return;
      case 'release':
        teardown();
        return;
      case 'none':
        return;
    }
  };

  const onUp = (event: PointerEvent) => {
    if (!drag || event.pointerId !== pointerId) {
      return;
    }

    const velocity = drag.up(event.timeStamp);

    if (claimed && velocity !== null) {
      owner.end(velocity, width);
    }

    teardown();
  };

  const onCancel = (event: PointerEvent) => {
    if (!drag || event.pointerId !== pointerId) {
      return;
    }

    if (claimed) {
      owner.cancel();
    }

    teardown();
  };

  const onTouchMove = (event: TouchEvent) => {
    if (!drag) {
      return;
    }

    if (event.touches.length > 1) {
      if (claimed) {
        owner.cancel();
      }

      teardown();
      return;
    }

    if (claimed && event.cancelable) {
      event.preventDefault();
    }
  };

  const onDown = (event: PointerEvent) => {
    if (drag || event.pointerType === 'mouse' || !event.isPrimary || event.button !== 0) {
      return;
    }

    const target = event.target;

    if (!(target instanceof Element) || !owner.canStart(target) || ownsRightwardDrag(target, root)) {
      return;
    }

    drag = new Drag('x');
    pointerId = event.pointerId;
    claimed = false;
    width = Math.max(1, root.clientWidth);
    drag.down(event.clientX, event.clientY, event.timeStamp);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    root.addEventListener('touchmove', onTouchMove, { passive: false });
  };

  root.addEventListener('pointerdown', onDown);

  return () => {
    root.removeEventListener('pointerdown', onDown);
    teardown();
  };
}
