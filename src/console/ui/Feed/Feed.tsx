// Feed (design: .feed): the column of a thread's events — messages,
// action groups, plans, system lines — up to --feed-max wide, centered in
// the main column. align="end" keeps a short feed at the bottom, next to
// the composer. The avatar indent (--feed-indent) that the indented items
// (quiet message, action group, plan, event line…) share is set here.

import type { ReactNode } from 'react';
import './Feed.css';

export function Feed({ children, align, className }: { children: ReactNode; align?: 'end'; className?: string }) {
  return (
    <div className={className ? `feed ${className}` : 'feed'} data-align={align}>
      {children}
    </div>
  );
}
