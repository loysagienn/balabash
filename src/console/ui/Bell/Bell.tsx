// Notification bell in the shell header (design: Bell): a regular icon-only
// button with the `bell` mixin; the count of new notifications sits on the
// icon's corner (none at 0). expanded — the notifications popover is open.

import type { MouseEvent } from 'react';
import { Icon } from '../Icon/Icon.tsx';
import { Count } from '../atoms/atoms.tsx';
import '../Btn/Btn.css';
import './Bell.css';

export type BellProps = {
  count: number;
  expanded?: boolean;
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
  className?: string;
};

export function bellLabel(count: number): string {
  return count > 0 ? `Notifications: ${count} new` : 'Notifications';
}

export function Bell({ count, expanded, onClick, className }: BellProps) {
  return (
    <button
      type="button"
      className={className ? `btn bell ${className}` : 'btn bell'}
      data-icon-only=""
      aria-label={bellLabel(count)}
      aria-expanded={expanded}
      onClick={onClick}
    >
      <Icon name="bell" />
      {count > 0 ? (
        <Count state="act" className="bell-count">
          {count}
        </Count>
      ) : null}
    </button>
  );
}
