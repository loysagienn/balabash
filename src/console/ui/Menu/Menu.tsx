// Menu (design: .menu, MenuItem): a list of actions on --surface-2 with a
// shadow. MenuLabel groups items, MenuSep separates groups. A MenuItem
// with `checked` set is a checkbox item (a check mark when on). MenuAnchor
// holds the "⋯" button of a row or header and, while open, shows the menu
// in a floating layer next to it — a portal into document.body positioned
// at the button (position: fixed), so a card or a list with overflow
// hidden does not clip it (the layer and its closing rules — ui/Float);
// the first item takes the focus on open, Up/Down move between the items.

import { useRef } from 'react';
import type { MouseEvent, ReactNode, RefObject } from 'react';
import { FloatLayer } from '../Float/Float.tsx';
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

// The menu in its floating layer (ui/Float): the first item takes the
// focus on open, Up/Down move between the items.
function MenuLayer({ anchor, onClose, children }: { anchor: RefObject<HTMLElement | null>; onClose: () => void; children: ReactNode }) {
  return (
    <FloatLayer anchor={anchor} onClose={onClose} className="menu-layer" focus={node => node.querySelector<HTMLElement>(ITEMS)?.focus()} onKeyDown={event => stepFocus(event, ITEMS, 'y')}>
      {children}
    </FloatLayer>
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
