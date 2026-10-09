// Terminal output (design: pre.term): command lines in mono, scrolling
// past --term-max-h. TermLine — one line (dim — a prompt or a banner);
// TermErr — an error fragment inside a line. Trunc (design: .trunc) — the
// honest truncation notice under a cut output, with a link to the full
// one.

import type { CSSProperties, ReactNode } from 'react';
import { Icon } from '../Icon/Icon.tsx';
import './Terminal.css';

export function Terminal({ children, maxH, className }: { children: ReactNode; maxH?: string; className?: string }) {
  return (
    <pre className={className ? `term ${className}` : 'term'} style={maxH ? ({ '--term-max-h': maxH } as CSSProperties) : undefined}>
      {children}
    </pre>
  );
}

export function TermLine({ children, dim }: { children?: ReactNode; dim?: boolean }) {
  return <span className={dim ? 'term-ln term-dim' : 'term-ln'}>{children}</span>;
}

export function TermErr({ children }: { children: ReactNode }) {
  return <span className="term-err">{children}</span>;
}

export function Trunc({ children }: { children: ReactNode }) {
  return (
    <span className="trunc">
      <Icon name="scissors" />
      {children}
    </span>
  );
}
