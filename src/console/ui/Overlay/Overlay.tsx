// Overlay — the root of a floating dialog (Modal, Sheet), rendered through
// a portal into document.body: the scrim plus the dialog's own layer as
// children. While it is open the dialog is really modal: everything else
// in document.body is inert (no clicks, no focus, hidden from assistive
// technology), Tab and Shift+Tab wrap inside the dialog, Escape closes,
// and the element that had the focus when it opened gets it back on
// close. The dialog is the descendant with role="dialog" (tabIndex −1, so
// it can hold the focus itself when no field inside takes it).
//
// The window comes and goes with a motion (overlayMotion.ts: a sheet
// slides, a modal fades) when it has one. The way out needs the window on
// the screen after its owner stopped rendering it: a Presence around the
// owner's condition (presence.tsx) keeps it and tells the overlay it is
// exiting; the overlay lets the page go at once — the background is
// interactive again and the opener has the focus back while the window
// is still sliding away — plays the exit and reports it over. `exitFrom`
// lets a finger's drag say where the exit starts (useSheetDrag).

import { useEffect, useRef } from 'react';
import type { ReactNode, RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Scrim } from '../Scrim/Scrim.tsx';
import { enter, exit, prefersReducedMotion } from './overlayMotion.ts';
import type { ExitFrom, OverlayMotion } from './overlayMotion.ts';
import { usePresence } from './presence.tsx';
import './Overlay.css';

const FOCUSABLE =
  'a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])';

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(el => el.getClientRects().length > 0);
}

export type OverlayProps = {
  onClose: () => void;
  motion?: OverlayMotion;
  exitFrom?: RefObject<ExitFrom | null>;
  children: ReactNode;
};

export function Overlay({ onClose, motion = 'none', exitFrom, children }: OverlayProps) {
  const root = useRef<HTMLDivElement>(null);
  // The latest onClose without re-running the lifecycle effect: an inline
  // callback changes on every render of the parent, the dialog must not
  // notice (it would lose the focus of a field on every keystroke).
  const close = useRef(onClose);
  // Who had the focus when the overlay opened — read during the first
  // render, before an autoFocus field inside takes it. Checked again once
  // mounted: when this dialog replaces another one in the same commit
  // (Confirm swapping its Modal for a Sheet on resize), the element read
  // here belongs to the dialog that is gone — but its cleanup has already
  // handed the focus back to the original opener, who is taken over.
  const opener = useRef<HTMLElement | null | undefined>(undefined);
  // Letting the page go: once, at the exit or at the unmount, whichever first.
  const leave = useRef<(() => void) | null>(null);
  const presence = usePresence();
  const exiting = presence?.exiting ?? false;
  const onExited = presence?.onExited;

  if (opener.current === undefined) {
    opener.current = document.activeElement as HTMLElement | null;
  }

  useEffect(() => {
    close.current = onClose;
  });

  useEffect(() => {
    const node = root.current;

    if (!node) {
      return;
    }

    const dialog = node.querySelector<HTMLElement>('[role="dialog"]');
    const scrim = node.querySelector<HTMLElement>('.scrim');
    const background = Array.from(document.body.children).filter(
      (el): el is HTMLElement => el instanceof HTMLElement && el !== node && !el.inert,
    );

    if (opener.current && !opener.current.isConnected) {
      const active = document.activeElement as HTMLElement | null;

      opener.current = active && !node.contains(active) ? active : null;
    }

    for (const el of background) {
      el.inert = true;
    }

    // An autoFocus field inside keeps the focus; otherwise the dialog takes
    // it — without scrolling: the window may be on its way in.
    if (dialog && !dialog.contains(document.activeElement)) {
      dialog.focus({ preventScroll: true });
    }

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close.current();
        return;
      }

      if (event.key !== 'Tab') {
        return;
      }

      const items = focusables(node);
      const active = document.activeElement as HTMLElement | null;
      const index = active ? items.indexOf(active) : -1;

      if (items.length === 0) {
        event.preventDefault();
        dialog?.focus({ preventScroll: true });
      } else if (event.shiftKey && (index <= 0 || !node.contains(active))) {
        event.preventDefault();
        items[items.length - 1].focus({ preventScroll: true });
      } else if (!event.shiftKey && (index === items.length - 1 || !node.contains(active))) {
        event.preventDefault();
        items[0].focus({ preventScroll: true });
      }
    };

    window.addEventListener('keydown', onKey);

    const coming = enter(motion, dialog, scrim, prefersReducedMotion());

    leave.current = () => {
      leave.current = null;
      window.removeEventListener('keydown', onKey);

      for (const el of background) {
        el.inert = false;
      }

      opener.current?.focus?.();
    };

    return () => {
      coming.cancel();
      leave.current?.();
    };
  }, [motion]);

  // The exit: the page let go, the motion played, the owner told.
  useEffect(() => {
    if (!exiting || !onExited) {
      return undefined;
    }

    const node = root.current;

    leave.current?.();

    const going = exit(
      motion,
      node?.querySelector<HTMLElement>('[role="dialog"]') ?? null,
      node?.querySelector<HTMLElement>('.scrim') ?? null,
      exitFrom?.current ?? null,
      prefersReducedMotion(),
    );
    let live = true;

    if (exitFrom) {
      exitFrom.current = null;
    }

    void going.finished.then(() => {
      if (live) {
        onExited();
      }
    });

    return () => {
      live = false;
      going.cancel();
    };
  }, [exiting, onExited, motion, exitFrom]);

  return createPortal(
    <div ref={root} className="overlay" data-exiting={exiting ? '' : undefined}>
      <Scrim onClick={() => close.current()} />
      {children}
    </div>,
    document.body,
  );
}
