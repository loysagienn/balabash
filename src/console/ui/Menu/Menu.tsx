// Menu (design: .menu, MenuItem): a list of actions on --surface-2 with a
// shadow. MenuLabel groups items, MenuSep separates groups. A MenuItem
// with `checked` set is a checkbox item (a check mark when on). MenuAnchor
// positions a menu under a "⋯" button in a row or header.

import type { MouseEvent, ReactNode } from 'react';
import { Icon } from '../Icon/Icon.tsx';
import type { IconName } from '../Icon/Icon.tsx';
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

export function MenuAnchor({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={className ? `menu-anchor ${className}` : 'menu-anchor'}>{children}</span>;
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
