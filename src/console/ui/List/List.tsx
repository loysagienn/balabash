// List (design: .list) — the container of rows (ThreadRow, AppRow, SkelRow,
// …) and the `list` container query. narrow="tiles" turns rows into tiles
// on the phone; endCols lays the right side of every row in shared columns.
// Row — the generic row of the design: a lead (avatar, object icon), the
// main column (title, meta, description) and the right side; one link as a
// whole (rule 14), or a div when the row carries its own buttons.
// ListGroup — a date or section divider between rows; LoadMore — the
// status line at the end while earlier rows load.

import type { CSSProperties, MouseEvent, ReactNode } from 'react';
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

export type RowProps = {
  lead?: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
  desc?: ReactNode;
  end?: ReactNode;
  // A link row when href is given; a plain row (its buttons are its own
  // links) otherwise.
  href?: string;
  onClick?: (event: MouseEvent<HTMLAnchorElement>) => void;
  current?: boolean;
  fresh?: boolean;
  className?: string;
};

export function Row({ lead, title, meta, desc, end, href, onClick, current, fresh, className }: RowProps) {
  const classes = className ? `row ${className}` : 'row';
  const body = (
    <>
      {lead}
      <span className="row-main">
        <span className="row-t">
          <span className="row-t-text">{title}</span>
        </span>
        {meta !== undefined && meta !== null ? <span className="row-m">{meta}</span> : null}
        {desc !== undefined && desc !== null ? <span className="row-d">{desc}</span> : null}
      </span>
      {end !== undefined && end !== null ? <span className="row-end">{end}</span> : null}
    </>
  );

  if (href !== undefined) {
    return (
      <a className={classes} href={href} onClick={onClick} aria-current={current ? 'page' : undefined} data-fresh={fresh ? '' : undefined}>
        {body}
      </a>
    );
  }

  return (
    <div className={classes} aria-current={current ? 'page' : undefined} data-fresh={fresh ? '' : undefined}>
      {body}
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
