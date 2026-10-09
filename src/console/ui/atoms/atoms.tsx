// The design's atoms — classes with no logic, typed as tiny components:
// count, attention dot, pulse, key, code chip, tag, quiet label, caption.

import type { HTMLAttributes, ReactNode } from 'react';
import type { StateName } from './state.ts';
import './atoms.css';

export type { StateName };

export function Count({ state, size, children, className, ...rest }: HTMLAttributes<HTMLSpanElement> & { state?: 'run' | 'act' | 'err'; size?: 'sm'; children: ReactNode }) {
  return (
    <span {...rest} className={className ? `count ${className}` : 'count'} data-state={state} data-size={size}>
      {children}
    </span>
  );
}

export function Attn({ className }: { className?: string }) {
  return <i className={className ? `attn ${className}` : 'attn'} aria-hidden="true" />;
}

export function Pulse({ off }: { off?: boolean }) {
  return <i className="pulse" data-state={off ? 'off' : undefined} aria-hidden="true" />;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

export function Code({ children, wrap }: { children: ReactNode; wrap?: boolean }) {
  return (
    <code className="code" data-wrap={wrap ? '' : undefined}>
      {children}
    </code>
  );
}

export function Tag({ children }: { children: ReactNode }) {
  return <span className="tag">{children}</span>;
}

export function Quiet({ children }: { children: ReactNode }) {
  return <span className="quiet">{children}</span>;
}

export function Caption({ children }: { children: ReactNode }) {
  return <span className="caption">{children}</span>;
}
