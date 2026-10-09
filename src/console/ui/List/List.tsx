// List (design: .list) — the container of rows (ThreadRow, AppRow, SkelRow,
// …) and the `list` container query. narrow="tiles" turns rows into tiles
// on the phone; endCols lays the right side of every row in shared columns.
// ListGroup — a date or section divider between rows; LoadMore — the
// status line at the end while earlier rows load.

import type { CSSProperties, ReactNode } from 'react';
import { Icon } from '../Icon/Icon.tsx';
import './List.css';

export type ListProps = {
  children: ReactNode;
  narrow?: 'tiles';
  // Column template of .row-end across the list, e.g. "96px 22px".
  endCols?: string;
  // Width of the time column when there is no column grid.
  timeW?: string;
  busy?: boolean;
  className?: string;
};

export function List({ children, narrow, endCols, timeW, busy, className }: ListProps) {
  const style = {
    ...(endCols ? { '--row-end-cols': endCols } : null),
    ...(timeW ? { '--row-time-w': timeW } : null),
  } as CSSProperties;

  return (
    <div className={className ? `list ${className}` : 'list'} data-narrow={narrow} data-end-cols={endCols ? '' : undefined} aria-busy={busy ? 'true' : undefined} style={style}>
      {children}
    </div>
  );
}

export function ListGroup({ children, end }: { children: ReactNode; end?: ReactNode }) {
  return (
    <div className="listgrp">
      {children}
      {end ? <span className="listgrp-end">{end}</span> : null}
    </div>
  );
}

export function LoadMore({ children }: { children: ReactNode }) {
  return (
    <div className="loadmore" role="status">
      <Icon name="loader-circle" spin />
      {children}
    </div>
  );
}
