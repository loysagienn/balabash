// Menu (design: .menu, MenuItem): a list of actions on --surface-2 with a
// shadow. MenuLabel groups items, MenuSep separates groups. A MenuItem
// with `checked` set is a checkbox item (a check mark when on). MenuAnchor
// holds the "⋯" button of a row or header and, while open, shows the menu
// in a floating layer next to it — a portal into document.body positioned
// at the button (position: fixed), so a card or a list with overflow
// hidden does not clip it. The layer closes on a click outside, Escape, a
// scroll, a resize, or when the focus leaves it; the first item takes the
// focus on open, Up/Down move between the items, the button gets the focus
// back on close.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent, ReactNode, RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../Icon/Icon.tsx';
import type { IconName } from '../Icon/Icon.tsx';
import { stepFocus } from '../atoms/keys.ts';
import './Menu.css';

export function Menu({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={className ? `menu ${className}` : 'menu'} role="menu" aria-label={label}>
      {children}
    </div>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <span className="menu-label">{children}</span>;
}

export function MenuSep() {
  return <span className="menu-sep" role="separator" />;
}

export type MenuAnchorProps = {
  open: boolean;
  onClose: () => void;
  // The <Menu> shown while open.
  menu: ReactNode;
  // The button that opens it.
  children: ReactNode;
  className?: string;
};

export function MenuAnchor({ open, onClose, menu, children, className }: MenuAnchorProps) {
  const anchor = useRef<HTMLSpanElement>(null);

  return (
    <span ref={anchor} className={className ? `menu-anchor ${className}` : 'menu-anchor'}>
      {children}
      {open ? (
        <MenuLayer anchor={anchor} onClose={onClose}>
          {menu}
        </MenuLayer>
      ) : null}
    </span>
  );
}

const ITEMS = '[role^="menuitem"]:not(:disabled)';
// Gap between the button and the menu (--sp-1) and the margin kept from
// the window edges.
const GAP = 4;
const EDGE = 8;

function MenuLayer({ anchor, onClose, children }: { anchor: RefObject<HTMLElement | null>; onClose: () => void; children: ReactNode }) {
  const layer = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  const [place, setPlace] = useState<CSSProperties>();

  useEffect(() => {
    close.current = onClose;
  });

  // Under the button, right edges aligned; above it when there is no room
  // below but there is above.
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

    node.querySelector<HTMLElement>(ITEMS)?.focus();

    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;

      if (!node.contains(target) && !anchor.current?.contains(target)) {
        close.current();
      }
    };

    const onKey = (event: KeyboardEvent) => {
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
      className="menu-layer"
      style={place}
      onKeyDown={event => stepFocus(event, ITEMS, 'y')}
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

export type MenuItemProps = {
  icon: IconName;
  label: ReactNode;
  variant?: 'danger';
  checked?: boolean;
  disabled?: boolean;
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
  // Content at the right edge: a key combination, a count.
  children?: ReactNode;
};

export function MenuItem({ icon, label, variant, checked, disabled, onClick, children }: MenuItemProps) {
  const check = checked !== undefined;

  return (
    <button
      type="button"
      className="mi"
      role={check ? 'menuitemcheckbox' : 'menuitem'}
      aria-checked={check ? checked : undefined}
      data-variant={variant}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon name={icon} />
      {label}
      {children || checked ? (
        <span className="mi-end">
          {children}
          {checked ? <Icon name="check" /> : null}
        </span>
      ) : null}
    </button>
  );
}
