// Threads — the flat list, newest first, grouped by day; earlier pages load
// as the reader scrolls. Filters and search are the route (ThreadFilters)
// and the server's; the rows are the store's projection over the loaded
// range (selectListThreads). The main thread is pinned above the list —
// in the list and while it loads — but only while no filter or search is
// set: a narrowed list shows what matched. A thread the tail starts while the
// list is at its head is inserted with a highlight; while the list is
// scrolled it waits above and an "N new threads" pill offers the way up.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { ThreadsRoute } from '../../lib/router/routes.ts';
import { useNow } from '../../lib/format/useNow.ts';
import { countOf } from '../../lib/format/index.ts';
import { useAppDispatch, useAppSelector } from '../../store/hooks.ts';
import { routeTo } from '../../store/router/actions.ts';
import { loadThreads } from '../../store/threads/actions.ts';
import { threadsFiltersOf } from '../../store/threads/filters.ts';
import { selectActiveCountIn, selectListThreads, selectMainThread, selectThreadsList } from '../../store/threads/selectors.ts';
import { Shell } from '../../features/shell/Shell.tsx';
import { emptyMatchNote, threadsBody, threadsFoot } from './ThreadsScreen.logic.ts';
import { segmentCount } from '../../features/thread-list/counts.ts';
import { ThreadFilters } from '../../features/thread-list/ThreadFilters.tsx';
import { ThreadList } from '../../features/thread-list/ThreadList.tsx';
import { hasFilters } from '../../features/thread-list/filters.ts';
import { Card } from '../../ui/Card/Card.tsx';
import { Empty } from '../../ui/Empty/Empty.tsx';
import { List, LoadMore } from '../../ui/List/List.tsx';
import { NewPill } from '../../ui/NewPill/NewPill.tsx';
import { Note } from '../../ui/Note/Note.tsx';
import { Screen } from '../../ui/Screen/Screen.tsx';
import { SkelRow } from '../../ui/Skel/Skel.tsx';
import './ThreadsScreen.css';

const SKELETON = [55, 35, 80, 60, 45];

// Visibility of an element inside the scrolling shell body. The sentinel
// mounts and unmounts with the screen's states (skeleton, rows, error), so
// the observer follows the node through a callback ref; without a node the
// answer returns to `initial`.
function useInView<T extends HTMLElement>(initial: boolean): [(node: T | null) => void, boolean, RefObject<T | null>] {
  const [inView, setInView] = useState(initial);
  const node = useRef<T>(null);
  const observer = useRef<IntersectionObserver | null>(null);
  const attach = useCallback(
    (next: T | null) => {
      observer.current?.disconnect();
      observer.current = null;
      node.current = next;

      if (next) {
        observer.current = new IntersectionObserver(entries => setInView(entries.some(entry => entry.isIntersecting)));
        observer.current.observe(next);
      } else {
        setInView(initial);
      }
    },
    [initial],
  );

  return [attach, inView, node];
}

export function ThreadsScreen({ route }: { route: ThreadsRoute }) {
  const dispatch = useAppDispatch();
  const now = useNow();
  const list = useAppSelector(selectThreadsList);
  const threads = useAppSelector(selectListThreads);
  const main = useAppSelector(selectMainThread);
  const projects = useAppSelector(s => s.projects);
  const streamSeq = useAppSelector(s => s.stream.lastSeq ?? s.stream.asOfSeq);
  const filters = list.filters ?? threadsFiltersOf(route, projects);
  const active = useAppSelector(s => selectActiveCountIn(s, filters));
  // The subtitle counts the whole set (All); the search caption counts the
  // rows of the selected status.
  const total = segmentCount(undefined, list.counts, active);
  const found = segmentCount(route.status, list.counts, active);

  // Rows above this seq are new to the screen: it opened with the store at streamSeq.
  const mountSeq = useRef<bigint | null>(null);

  if (mountSeq.current === null && streamSeq !== null) {
    mountSeq.current = streamSeq;
  }

  // The head of the list freezes while it is scrolled; newer rows wait above.
  const [topRef, atTop, topNode] = useInView<HTMLDivElement>(true);
  const newest = threads[0]?.createdSeq ?? null;
  const [head, setHead] = useState<bigint | null>(null);

  useEffect(() => {
    if (atTop && newest !== head) {
      setHead(newest);
    }
  }, [atTop, newest, head]);

  const shownHead = atTop ? newest : head;
  const rows = shownHead === null ? threads : threads.filter(thread => thread.createdSeq <= shownHead);
  const waiting = threads.length - rows.length;

  // Earlier pages: the status line at the end asks for the next one whenever it is in view.
  const [moreRef, moreInView] = useInView<HTMLDivElement>(false);
  const { loading, error, nextCursor } = list;

  useEffect(() => {
    if (moreInView && !loading && !error && nextCursor !== null && list.filters) {
      dispatch(loadThreads(list.filters, nextCursor));
    }
  }, [moreInView, loading, error, nextCursor, list.filters, dispatch]);

  const stage = threadsBody(list, threads.length);
  const firstPage = stage === 'skeleton' || stage === 'failed';
  const retry = () => dispatch(loadThreads(filters, firstPage ? null : nextCursor));
  const toTop = () => topNode.current?.closest('.shell-body')?.scrollTo({ top: 0, behavior: 'smooth' });

  // The status line of the loaded range: under the rows, or under the empty
  // state when the browser-side filters hide every loaded row.
  const footKind = threadsFoot(list);
  const foot =
    footKind === 'retry' && error ? (
      <Note state="err" icon="cloud-off" role="alert" action="Retry" actionIcon="refresh-cw" onAction={retry}>
        Couldn’t load earlier threads: {error.message}
      </Note>
    ) : footKind === 'more' ? (
      <div ref={moreRef}>
        <LoadMore>{loading ? 'Loading earlier threads…' : 'Earlier threads'}</LoadMore>
      </div>
    ) : null;

  // The main thread above everything else, whatever the stage of the list,
  // unless the route narrows the list.
  const mainPinned = hasFilters(route) ? null : main;
  const pinned = mainPinned ? <ThreadList threads={[]} pinned={mainPinned} now={now} /> : null;
  let body;

  if (stage === 'skeleton') {
    body = (
      <Card narrow="bare">
        {pinned}
        <List narrow="tiles" busy>
          {SKELETON.map((w, i) => (
            <SkelRow key={i} widths={[w, 35]} />
          ))}
        </List>
      </Card>
    );
  } else if (stage === 'failed') {
    body = (
      <Card narrow="bare">
        {pinned}
        <Empty icon="cloud-off" state="err" title="Couldn’t load threads" action="Retry" actionIcon="refresh-cw" onAction={retry}>
          {error?.message}
        </Empty>
      </Card>
    );
  } else if (stage === 'empty') {
    body = (
      <Card narrow="bare">
        {pinned}
        {hasFilters(route) ? (
          <Empty icon="circle-check" title="No threads match" action="Reset filters" onAction={() => dispatch(routeTo({ key: 'threads' }, { replace: true }))}>
            {emptyMatchNote(footKind)}
          </Empty>
        ) : (
          <Empty icon="messages-square" title="No threads yet">
            Threads appear here as agents start working.
          </Empty>
        )}
        {foot}
      </Card>
    );
  } else {
    body = (
      <Card narrow="bare">
        <ThreadList threads={rows} pinned={mainPinned} now={now} hit={route.q} hitTotal={found} freshAfter={mountSeq.current} foot={foot} />
      </Card>
    );
  }

  return (
    <Shell current="threads" title="Threads" sub={total === undefined ? undefined : countOf(total, 'thread')}>
      <Screen>
        <div ref={topRef} className="thl-top" aria-hidden="true" />
        {waiting > 0 ? (
          <div className="thl-pillbar">
            <NewPill label={countOf(waiting, 'new thread')} onClick={toTop} />
          </div>
        ) : null}
        <ThreadFilters route={route} counts={list.counts} active={active} />
        {body}
      </Screen>
    </Shell>
  );
}
