// Tooltip (design: .tip) and its hover anchor (.hint): the tip shows on
// hover and keyboard focus of the anchor. A tooltip adds, it doesn't hide:
// the same value is always visible somewhere else.

import type { ReactNode } from 'react';
import './Hint.css';

export function Tip({ children, hint, className }: { children: ReactNode; hint?: boolean; className?: string }) {
  const classes = ['tip', hint ? 'hint-tip' : null, className].filter(Boolean).join(' ');

  return (
    <span className={classes} role="tooltip">
      {children}
    </span>
  );
}

// label — what assistive technology reads instead of the visual pair.
export function Hint({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <span className={className ? `hint ${className}` : 'hint'} aria-label={label} tabIndex={0}>
      {children}
    </span>
  );
}
