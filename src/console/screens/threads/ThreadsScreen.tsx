// Threads — the flat list, newest first, grouped by day; earlier pages load
// as the reader scrolls. Filters and search are the route (ThreadFilters);
// the rows are the store's projection over the loaded range
// (selectVisibleListThreads). A thread the tail starts while the list is at
// its head is inserted with a highlight; while the list is scrolled it waits
// above and an "N new threads" pill offers the way up.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { ThreadsRoute } from '../../lib/router/routes.ts';
import { useNow } from '../../lib/format/useNow.ts';
import { countOf } from '../../lib/format/index.ts';
import { useAppDispatch, useAppSelector } from '../../store/hooks.ts';
import { routeTo } from '../../store/router/actions.ts';
import { loadThreads } from '../../store/threads/actions.ts';
import { threadsFiltersOf } from '../../store/threads/filters.ts';
import { selectThreadsList, selectVisibleListThreads } from '../../store/threads/selectors.ts';
import { Shell } from '../../features/shell/Shell.tsx';
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
  const threads = useAppSelector(selectVisibleListThreads);
  const projects = useAppSelector(s => s.projects);
  const streamSeq = useAppSelector(s => s.stream.lastSeq ?? s.stream.asOfSeq);
  const filters = list.filters ?? threadsFiltersOf(route, projects);

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

  const firstPage = list.ids.length === 0 && threads.length === 0;
  const retry = () => dispatch(loadThreads(filters, firstPage ? null : nextCursor));
  const toTop = () => topNode.current?.closest('.shell-body')?.scrollTo({ top: 0, behavior: 'smooth' });

  let body;

  if (firstPage && loading) {
    body = (
      <Card narrow="bare">
        <List narrow="tiles" busy>
          {SKELETON.map((w, i) => (
            <SkelRow key={i} widths={[w, 35]} />
          ))}
        </List>
      </Card>
    );
  } else if (firstPage && error) {
    body = (
      <Card narrow="bare">
        <Empty icon="cloud-off" state="err" title="Couldn’t load threads" action="Retry" actionIcon="refresh-cw" onAction={retry}>
          {error.message}
        </Empty>
      </Card>
    );
  } else if (threads.length === 0 && list.filters && !loading) {
    body = (
      <Card narrow="bare">
        {hasFilters(route) ? (
          <Empty icon="circle-check" title="No threads match" action="Reset filters" onAction={() => dispatch(routeTo({ key: 'threads' }, { replace: true }))}>
            {nextCursor !== null ? 'Among the threads loaded so far; earlier ones may match.' : 'Nothing with these filters in the whole list.'}
          </Empty>
        ) : (
          <Empty icon="messages-square" title="No threads yet">
            Threads appear here as agents start working.
          </Empty>
        )}
      </Card>
    );
  } else {
    body = (
      <Card narrow="bare">
        <ThreadList
          threads={rows}
          now={now}
          hit={route.q}
          freshAfter={mountSeq.current}
          foot={
            error ? (
              <Note state="err" icon="cloud-off" role="alert" action="Retry" actionIcon="refresh-cw" onAction={retry}>
                Couldn’t load earlier threads: {error.message}
              </Note>
            ) : nextCursor !== null ? (
              <div ref={moreRef}>
                <LoadMore>{loading ? 'Loading earlier threads…' : 'Earlier threads'}</LoadMore>
              </div>
            ) : null
          }
        />
      </Card>
    );
  }

  return (
    <Shell current="threads" title="Threads">
      <Screen>
        <div ref={topRef} className="thl-top" aria-hidden="true" />
        {waiting > 0 ? (
          <div className="thl-pillbar">
            <NewPill label={countOf(waiting, 'new thread')} onClick={toTop} />
          </div>
        ) : null}
        <ThreadFilters route={route} />
        {body}
      </Screen>
    </Shell>
  );
}
