// Thread link in the details rail (design: RailLink): the parent thread
// (up — an arrow instead of a state) or a child thread with its state.
// href / onClick as everywhere in ui: the feature passes the route's href
// and intercepts the plain click.

import type { MouseEvent } from 'react';
import { Avatar } from '../Avatar/Avatar.tsx';
import { Icon } from '../Icon/Icon.tsx';
import { Status } from '../Status/Status.tsx';
import type { StateName } from '../atoms/state.ts';
import './RailLink.css';

export type RailLinkProps = {
  agent: string;
  text: string;
  up?: boolean;
  state?: StateName;
  href: string;
  onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
};

export function RailLink({ agent, text, up, state, href, onClick }: RailLinkProps) {
  return (
    <a className="th-rail-link" href={href} onClick={onClick}>
      <Avatar agent={agent} size="sm" />
      <span className="th-rail-link-t">{text}</span>
      {up ? <Icon name="arrow-up" size="sm" /> : state ? <Status state={state} /> : null}
    </a>
  );
}
