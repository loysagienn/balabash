// Overlay — the root of a floating dialog (Modal, Sheet), rendered through
// a portal into document.body: the scrim plus the dialog's own layer as
// children. While it is open the dialog is really modal: everything else
// in document.body is inert (no clicks, no focus, hidden from assistive
// technology), Tab and Shift+Tab wrap inside the dialog, Escape closes,
// and the element that had the focus when it opened gets it back on
// close. The dialog is the descendant with role="dialog" (tabIndex −1, so
// it can hold the focus itself when no field inside takes it).

import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Scrim } from '../Scrim/Scrim.tsx';
import './Overlay.css';

const FOCUSABLE = 'a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])';

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(el => el.getClientRects().length > 0);
}

export function Overlay({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  // The latest onClose without re-running the lifecycle effect: an inline
  // callback changes on every render of the parent, the dialog must not
  // notice (it would lose the focus of a field on every keystroke).
  const close = useRef(onClose);
  // Who had the focus when the overlay opened — read during the first
  // render, before an autoFocus field inside takes it.
  const [opener] = useState(() => document.activeElement as HTMLElement | null);

  useEffect(() => {
    close.current = onClose;
  });

  useEffect(() => {
    const node = root.current;

    if (!node) {
      return;
    }

    const dialog = node.querySelector<HTMLElement>('[role="dialog"]');
    const background = Array.from(document.body.children).filter((el): el is HTMLElement => el instanceof HTMLElement && el !== node && !el.inert);

    for (const el of background) {
      el.inert = true;
    }

    // An autoFocus field inside keeps the focus; otherwise the dialog takes it.
    if (dialog && !dialog.contains(document.activeElement)) {
      dialog.focus();
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
        dialog?.focus();
      } else if (event.shiftKey && (index <= 0 || !node.contains(active))) {
        event.preventDefault();
        items[items.length - 1].focus();
      } else if (!event.shiftKey && (index === items.length - 1 || !node.contains(active))) {
        event.preventDefault();
        items[0].focus();
      }
    };

    window.addEventListener('keydown', onKey);

    return () => {
      window.removeEventListener('keydown', onKey);

      for (const el of background) {
        el.inert = false;
      }

      opener?.focus?.();
    };
  }, [opener]);

  return createPortal(
    <div ref={root} className="overlay">
      <Scrim onClick={() => close.current()} />
      {children}
    </div>,
    document.body,
  );
}
