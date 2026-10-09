// Page grid of 12 columns (design: .grid12): columns span 4 · 5 · 7 · 8 ·
// 12; a stacking column (`stack`) lays its cards one under another. On the
// phone the grid is a single column.

import type { ReactNode } from 'react';
import './Grid12.css';

export function Grid12({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={className ? `grid12 ${className}` : 'grid12'}>{children}</div>;
}

export type Grid12ColProps = {
  span: 4 | 5 | 7 | 8 | 12;
  stack?: boolean;
  className?: string;
  children: ReactNode;
};

export function Grid12Col({ span, stack, className, children }: Grid12ColProps) {
  return (
    <div className={className} data-span={span} data-stack={stack ? '' : undefined}>
      {children}
    </div>
  );
}
