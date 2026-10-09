// Child thread in the feed (design: ChildThread): who, what about, when;
// its state and "Open" (href of the thread route, onOpen intercepts the
// plain click); the summary, when there is one, is children.

import type { MouseEvent, ReactNode } from 'react';
import { Avatar } from '../Avatar/Avatar.tsx';
import { Badge } from '../Badge/Badge.tsx';
import { Btn } from '../Btn/Btn.tsx';
import { threadStateLabel } from '../ThreadHead/ThreadHead.logic.ts';
import type { StateName } from '../atoms/state.ts';
import './ChildThread.css';

export type ChildThreadProps = {
  agent: string;
  title: string;
  sub?: string;
  state: StateName;
  label?: string;
  href: string;
  onOpen?: (event: MouseEvent<HTMLElement>) => void;
  children?: ReactNode;
};

export function ChildThread({ agent, title, sub, state, label, href, onOpen, children }: ChildThreadProps) {
  return (
    <div className="childth">
      <div className="childth-h">
        <Avatar agent={agent} size="sm" />
        <span className="childth-t">
          <b className="childth-name">{title}</b>
          {sub ? <small className="childth-sub">{sub}</small> : null}
        </span>
        <Badge state={state} label={threadStateLabel(state, label)} />
        <Btn label="Open" variant="ghost" size="sm" iconAfter="arrow-up-right" href={href} onClick={onOpen} />
      </div>
      {children ? <div className="childth-b">{children}</div> : null}
    </div>
  );
}
