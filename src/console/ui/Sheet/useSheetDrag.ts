// The sheet pulled by its head (the grab, the title, the description —
// the body keeps its own scroll and the buttons their presses): a finger
// (or a mouse) on the head drags the sheet down with it, the scrim
// lightening as it goes; up is held back (a quarter of the pull); the
// lift settles it (lib/gesture/settle: the fling and the half decide) —
// back into place, or down out of the window, through the owner's
// onClose with the exit starting where the finger left the sheet
// (Overlay, exitFrom). The head owns its touches (touch-action: none,
// Sheet.css), so the page under the scrim neither scrolls nor bounces.

import { useCallback, useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { Drag } from '../../lib/gesture/drag.ts';
import { settle } from '../../lib/gesture/settle.ts';
import { prefersReducedMotion } from '../Overlay/overlayMotion.ts';
import type { ExitFrom } from '../Overlay/overlayMotion.ts';

const EASE_OUT = 'cubic-bezier(0,0,.2,1)';
// A pull upward moves the sheet this share of the way.
const UP_RESISTANCE = 0.25;

export type SheetDrag = {
  headRef: (element: HTMLElement | null) => void;
  sheetRef: (element: HTMLElement | null) => void;
  // Where the exit starts when the drag closed the sheet (the Overlay reads it).
  exitFrom: RefObject<ExitFrom | null>;
};

export function useSheetDrag(onClose: () => void): SheetDrag {
  const head = useRef<HTMLElement | null>(null);
  const sheet = useRef<HTMLElement | null>(null);
  const exitFrom = useRef<ExitFrom | null>(null);
  const close = useRef(onClose);
  const headRef = useCallback((element: HTMLElement | null) => {
    head.current = element;
  }, []);
  const sheetRef = useCallback((element: HTMLElement | null) => {
    sheet.current = element;
  }, []);

  useEffect(() => {
    close.current = onClose;
  });

  useEffect(() => {
    const headEl = head.current;
    const sheetEl = sheet.current;

    if (!headEl || !sheetEl) {
      return undefined;
    }

    const scrim = sheetEl.parentElement?.querySelector<HTMLElement>('.scrim') ?? null;
    let drag: Drag | null = null;
    let pointerId = -1;
    let pull = 0;

    const paint = (y: number) => {
      sheetEl.style.transform = y === 0 ? '' : `translateY(${y}px)`;

      if (scrim) {
        scrim.style.opacity = y <= 0 ? '' : `${Math.max(0, 1 - y / sheetEl.offsetHeight)}`;
      }
    };
    const settleBack = (duration: number) => {
      const from = pull;

      pull = 0;

      if (from === 0 || duration === 0) {
        paint(0);
        return;
      }

      const options: KeyframeAnimationOptions = { duration, easing: EASE_OUT };
      const animations = [
        sheetEl.animate([{ transform: `translateY(${from}px)` }, { transform: 'translateY(0)' }], options),
      ];

      if (scrim && from > 0) {
        animations.push(
          scrim.animate([{ opacity: Math.max(0, 1 - from / sheetEl.offsetHeight) }, { opacity: 1 }], options),
        );
      }

      paint(0);
    };
    const release = () => {
      drag = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
    };

    const onMove = (event: PointerEvent) => {
      if (!drag || event.pointerId !== pointerId) {
        return;
      }

      const move = drag.move(event.clientX, event.clientY, event.timeStamp);

      if (move.kind === 'release') {
        release();
        return;
      }

      if (move.kind === 'move') {
        pull = move.travel >= 0 ? move.travel : move.travel * UP_RESISTANCE;
        paint(pull);
      }
    };
    const onUp = (event: PointerEvent) => {
      if (!drag || event.pointerId !== pointerId) {
        return;
      }

      const velocity = drag.up(event.timeStamp);

      release();

      if (velocity === null) {
        return;
      }

      const height = Math.max(1, sheetEl.offsetHeight);
      const { target, duration } = settle({
        progress: pull / height,
        velocity,
        extent: height,
        reduced: prefersReducedMotion(),
      });

      if (target === 1) {
        exitFrom.current = { offset: Math.max(0, pull) / height, duration };
        pull = 0;
        close.current();
      } else {
        settleBack(duration);
      }
    };
    const onCancel = (event: PointerEvent) => {
      if (!drag || event.pointerId !== pointerId) {
        return;
      }

      release();
      settleBack(settle({ progress: pull / Math.max(1, sheetEl.offsetHeight), velocity: 0, extent: 1 }).duration);
    };
    const onDown = (event: PointerEvent) => {
      if (drag || !event.isPrimary || event.button !== 0) {
        return;
      }

      drag = new Drag('y');
      pointerId = event.pointerId;
      pull = 0;
      drag.down(event.clientX, event.clientY, event.timeStamp);
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onCancel);
    };

    headEl.addEventListener('pointerdown', onDown);

    return () => {
      headEl.removeEventListener('pointerdown', onDown);
      release();
    };
  }, []);

  return { headRef, sheetRef, exitFrom };
}
