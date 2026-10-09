// Section link with a summary (design: SectionLink) and its container
// (design: nav.seclinks). The summary is colored (state) only for what
// awaits action. On the phone narrow="tiles" lays the sections 3 × N as
// tiles, with a summary only where action awaits.

import type { CSSProperties, MouseEvent, ReactNode } from 'react';
import { Icon } from '../Icon/Icon.tsx';
import type { IconName } from '../Icon/Icon.tsx';
import type { StateName } from '../atoms/state.ts';
import './SectionLink.css';

export function SectionLinks({
  children,
  label = 'Sections',
  narrow,
  min,
  className,
}: {
  children: ReactNode;
  label?: string;
  narrow?: 'tiles';
  min?: string;
  className?: string;
}) {
  return (
    <nav
      className={className ? `seclinks ${className}` : 'seclinks'}
      aria-label={label}
      data-narrow={narrow}
      style={min ? ({ '--seclink-min': min } as CSSProperties) : undefined}
    >
      {children}
    </nav>
  );
}

export type SectionLinkProps = {
  icon: IconName;
  title: string;
  meta?: string;
  state?: StateName;
  href: string;
  onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
};

export function SectionLink({ icon, title, meta, state, href, onClick }: SectionLinkProps) {
  return (
    <a className="seclink" href={href} onClick={onClick}>
      <Icon name={icon} />
      <span className="seclink-t">{title}</span>
      {meta ? (
        <span className="seclink-m" data-state={state}>
          {meta}
        </span>
      ) : null}
    </a>
  );
}
