// FloatLayer — a panel floating next to its button in a layer over the
// screen: a portal into document.body positioned at the anchor (position:
// fixed, so a card or a list with overflow hidden does not clip it), under
// the button with the right edges aligned, above it when there is no room
// below but there is above. It closes on a click outside, Escape, a scroll
// outside it, a resize, or when the focus leaves it; on open the focus
// moves inside (focus — where exactly: a menu takes its first item, a
// popover takes itself), and the button gets it back on close. Shared by
// the menus (MenuAnchor) and the shell's popovers (the bell).

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, ReactNode, RefObject } from 'react';
import { createPortal } from 'react-dom';
import './Float.css';

// Gap between the button and the panel (--sp-1) and the margin kept from
// the window edges.
const GAP = 4;
const EDGE = 8;

export type FloatLayerProps = {
  anchor: RefObject<HTMLElement | null>;
  onClose: () => void;
  className?: string;
  // Where the focus goes on open; the layer itself by default.
  focus?: (layer: HTMLElement) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  children: ReactNode;
};

export function FloatLayer({ anchor, onClose, className, focus, onKeyDown, children }: FloatLayerProps) {
  const layer = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  const take = useRef(focus);
  const [place, setPlace] = useState<CSSProperties>();

  useEffect(() => {
    close.current = onClose;
    take.current = focus;
  });

  useLayoutEffect(() => {
    const at = anchor.current?.getBoundingClientRect();
    const height = layer.current?.offsetHeight ?? 0;

    if (!at) {
      return;
    }

    const below = at.bottom + GAP + height <= window.innerHeight - EDGE || at.top - GAP - height < EDGE;

    setPlace({
      right: Math.max(EDGE, window.innerWidth - at.right),
      ...(below ? { top: at.bottom + GAP } : { bottom: window.innerHeight - at.top + GAP }),
    });
  }, [anchor]);

  useEffect(() => {
    const node = layer.current;

    if (!node) {
      return;
    }

    const opener = document.activeElement as HTMLElement | null;

    if (take.current) {
      take.current(node);
    } else {
      node.focus();
    }

    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;

      if (!node.contains(target) && !anchor.current?.contains(target)) {
        close.current();
      }
    };

    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close.current();
      }
    };

    const onScroll = (event: Event) => {
      if (!node.contains(event.target as Node)) {
        close.current();
      }
    };

    const onResize = () => close.current();

    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);

    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);

      // The focus was inside the layer (now gone): back to the button.
      if (document.activeElement === document.body || document.activeElement === null) {
        opener?.focus?.();
      }
    };
  }, [anchor]);

  return createPortal(
    <div
      ref={layer}
      className={className ? `float-layer ${className}` : 'float-layer'}
      style={place}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onBlur={event => {
        if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) {
          close.current();
        }
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
