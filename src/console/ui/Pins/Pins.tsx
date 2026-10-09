// The project's main files pinned above the list (design: Pins): entry
// (AGENTS.md), inbox and journal — three tiles in a row, each a link with
// the file name in monospace and a caption that the feature composes
// ("3 new entries", "updated yesterday").

import type { MouseEvent, ReactNode } from 'react';
import { Icon } from '../Icon/Icon.tsx';
import type { IconName } from '../Icon/Icon.tsx';
import './Pins.css';

export function Pins({ children }: { children: ReactNode }) {
  return <div className="pins">{children}</div>;
}

export type PinProps = {
  icon: IconName;
  name: string;
  desc: string;
  href: string;
  onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
};

export function Pin({ icon, name, desc, href, onClick }: PinProps) {
  return (
    <a className="pin" href={href} onClick={onClick}>
      <b className="pin-t">
        <Icon name={icon} />
        {name}
      </b>
      <small className="pin-d">{desc}</small>
    </a>
  );
}
