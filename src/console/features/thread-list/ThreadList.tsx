// The thread list of a section (Threads, Home, a project): rows in the
// design's three right-hand columns, grouped by the day they started, or
// under one caption when a search narrows them. The main thread, when
// pinned, stands first as a compact row above the day groups — outside
// the days and the pages (the screen pins it only without filters). Rows
// newer than `freshAfter` flash as new (a thread the tail started while
// the screen was open).

import { Fragment } from 'react';
import type { ReactNode } from 'react';
import type { Thread } from '../../../core/contract.ts';
import { countOf } from '../../lib/format/index.ts';
import { List, ListGroup } from '../../ui/List/List.tsx';
import { groupByDay } from './groups.ts';
import { ThreadListRow } from './ThreadListRow.tsx';
import './ThreadList.css';

export type ThreadListProps = {
  threads: Thread[];
  now: Date;
  // The workspace's main thread, pinned above the rows.
  pinned?: Thread | null;
  // The search term: one group "N found" with the matches highlighted.
  hit?: string;
  // How many threads the search found in the whole list (the server's
  // count); the loaded rows are counted without it.
  hitTotal?: number;
  // createdSeq above which a row is new to this screen.
  freshAfter?: bigint | null;
  currentId?: string;
  noAgent?: boolean;
  // Without day dividers (a short list on Home).
  flat?: boolean;
  // The status line after the rows (loading earlier, an error).
  foot?: ReactNode;
  className?: string;
};

export function ThreadList({ threads, pinned, now, hit, hitTotal, freshAfter = null, currentId, noAgent, flat, foot, className }: ThreadListProps) {
  const row = (thread: Thread) => (
    <ThreadListRow
      key={thread.id}
      thread={thread}
      now={now}
      hit={hit}
      fresh={freshAfter !== null && thread.createdSeq > freshAfter}
      current={thread.id === currentId}
      noAgent={noAgent}
    />
  );

  return (
    <List className={className ? `thl-list ${className}` : 'thl-list'} endCols="auto var(--thl-time-w, 140px) var(--thl-ctx-w, 60px)" narrow="tiles">
      {pinned ? <ThreadListRow thread={pinned} now={now} current={pinned.id === currentId} main /> : null}
      {hit ? (
        <>
          <ListGroup end="in titles and summaries">{`${(hitTotal ?? threads.length).toLocaleString('en-US')} found`}</ListGroup>
          {threads.map(row)}
        </>
      ) : flat ? (
        threads.map(row)
      ) : (
        groupByDay(threads, now).map(group => (
          <Fragment key={group.key}>
            <ListGroup end={countOf(group.threads.length, 'thread')}>{group.label}</ListGroup>
            {group.threads.map(row)}
          </Fragment>
        ))
      )}
      {foot}
    </List>
  );
}
