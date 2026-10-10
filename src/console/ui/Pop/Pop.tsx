// Shell popover (design: .pop) — the panel under the activity indicator
// ("Running now") and under the bell ("Notifications"): a head with a
// count and actions on the right (PopHead), group labels (PopGroup), rows
// and a footer (PopFoot). PopItem is the row of "Running now": agent,
// thread, what it is doing (metaCode — as a command) and the live timer
// with the state; a link as a whole. The panel is focusable (tabIndex -1)
// and hands out its element: the feature focuses the named dialog on open
// and whenever a control inside it is about to leave the DOM. Where the
// panel floats — next to its button, in a layer over the screen — is the
// feature's business.

import type { MouseEvent, ReactNode, Ref } from 'react';
import { Avatar } from '../Avatar/Avatar.tsx';
import { Status } from '../Status/Status.tsx';
import { Code, Count } from '../atoms/atoms.tsx';
import './Pop.css';

export function Pop({ label, children, className, ref }: { label: string; children: ReactNode; className?: string; ref?: Ref<HTMLDivElement> }) {
  return (
    <div ref={ref} className={className ? `pop ${className}` : 'pop'} role="dialog" aria-label={label} tabIndex={-1}>
      {children}
    </div>
  );
}

export type PopHeadProps = {
  title: ReactNode;
  count?: number;
  countState?: 'run' | 'act' | 'err';
  // Actions on the right ("Mark all read").
  end?: ReactNode;
};

export function PopHead({ title, count, countState, end }: PopHeadProps) {
  return (
    <div className="pop-h">
      {title}
      {count !== undefined && count > 0 ? <Count state={countState}>{count}</Count> : null}
      {end ? <span className="pop-h-end">{end}</span> : null}
    </div>
  );
}

export function PopGroup({ children }: { children: ReactNode }) {
  return <div className="pop-g">{children}</div>;
}

export function PopFoot({ children }: { children: ReactNode }) {
  return <div className="pop-f">{children}</div>;
}

export type PopItemProps = {
  agent: string;
  title: string;
  // "engineer · " before the command, or the whole line without one.
  meta?: string;
  metaCode?: string;
  state: 'run' | 'wait' | 'act';
  time: string;
  href: string;
  onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
};

export function PopItem({ agent, title, meta, metaCode, state, time, href, onClick }: PopItemProps) {
  return (
    <a className="pop-i" href={href} onClick={onClick}>
      <Avatar agent={agent} size="sm" />
      <span className="pop-i-main">
        <span className="pop-i-t">{title}</span>
        <span className="pop-i-m">
          {meta}
          {metaCode ? <Code>{metaCode}</Code> : null}
        </span>
      </span>
      <span className="pop-i-end">
        <Status state={state} label={time} />
      </span>
    </a>
  );
}
