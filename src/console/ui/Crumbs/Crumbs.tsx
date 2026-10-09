// Breadcrumbs (design: Crumbs): the path separated by "/", the last part is
// current. lead — an icon before the root (a project folder); fa — the path
// in the file area header. Items carry href and onClick: a feature builds
// them from routes (writeRoute + the plain-left-click rule of Link).

import type { MouseEvent, ReactNode } from 'react';
import { Icon } from '../Icon/Icon.tsx';
import type { IconName } from '../Icon/Icon.tsx';
import './Crumbs.css';

export type Crumb = {
  label: ReactNode;
  href: string;
  onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
};

export type CrumbsProps = {
  items: Crumb[];
  current: ReactNode;
  lead?: IconName;
  fa?: boolean;
};

export function Crumbs({ items, current, lead, fa }: CrumbsProps) {
  return (
    <nav className={fa ? 'crumbs fa-path' : 'crumbs'} aria-label="Breadcrumbs">
      {lead ? <Icon name={lead} /> : null}
      {items.map((item, i) => (
        <span key={i} className="crumbs-part">
          <a className="crumbs-i" href={item.href} onClick={item.onClick}>
            {item.label}
          </a>
          <Icon name="chevron-right" className="crumbs-sep" />
        </span>
      ))}
      <span className="crumbs-cur" aria-current="page">
        {current}
      </span>
    </nav>
  );
}
