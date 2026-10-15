// The design's atoms — classes with no logic, typed as tiny components:
// count, attention dot, pulse, key, code chip, tag, quiet label, caption,
// URL chip, search match, inline error.

import type { HTMLAttributes, MouseEvent, ReactNode } from 'react';
import { Icon } from '../Icon/Icon.tsx';
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

// The address chip (design: .url), one line that shrinks with its place —
// a long address (a slug may be 64 characters) ends in an ellipsis: the public link (a globe, the accent chip) or, with
// variant "owner", the owner link (a lock, a neutral chip). A link when
// href is given, text otherwise; the whole value is in its title.
export function Url({ children, href, onClick, variant, title }: { children: string; href?: string; onClick?: (event: MouseEvent<HTMLAnchorElement>) => void; variant?: 'owner'; title?: string }) {
  const icon = <Icon name={variant === 'owner' ? 'lock' : 'globe'} />;

  if (href) {
    return (
      <a className="url" data-variant={variant} href={href} target="_blank" rel="noreferrer" title={title ?? children} onClick={onClick}>
        {icon}
        <span className="url-t">{children}</span>
      </a>
    );
  }

  return (
    <span className="url" data-variant={variant} title={title ?? children}>
      {icon}
      <span className="url-t">{children}</span>
    </span>
  );
}

// A highlighted search match (design: mark.hit).
export function Hit({ children }: { children: ReactNode }) {
  return <mark className="hit">{children}</mark>;
}

// An inline error line (design: .errline): the alert icon and a text that
// may hold a .code chip.
export function ErrorLine({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={className ? `errline ${className}` : 'errline'}>
      <Icon name="circle-alert" />
      <span>{children}</span>
    </span>
  );
}
