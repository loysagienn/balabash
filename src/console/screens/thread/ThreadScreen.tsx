// Thread — the header, the summary of a finished thread, the feed of three
// weights (features/thread-feed), the composer and the details rail. The
// feed is the store's projection of the thread's events: the route loads
// the newest chunk, earlier ones load as the reader scrolls to the top
// (the scroll position stays on the same event), the tail appends live.
// A thread outside the snapshot window is fetched by id first.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Thread as ThreadRecord } from '../../../core/contract.ts';
import { countOf, dateTimeLabel } from '../../lib/format/index.ts';
import { useNow } from '../../lib/format/useNow.ts';
import { useAppDispatch, useAppSelector } from '../../store/hooks.ts';
import { makeSelectThreadEvents, selectThreadFeed } from '../../store/feed/selectors.ts';
import { selectMe } from '../../store/session/selectors.ts';
import { selectSession, selectThreadState } from '../../store/sessions/selectors.ts';
import { loadThread, loadThreadEvents, sendMessage } from '../../store/threads/actions.ts';
import { selectThread } from '../../store/threads/selectors.ts';
import { setComposerDraft } from '../../store/ui/actions.ts';
import { selectComposerDraft, selectComposerSending } from '../../store/ui/selectors.ts';
import { Shell } from '../../features/shell/Shell.tsx';
import { threadTitle, ctxOf } from '../../features/thread-list/rowData.ts';
import { Attachments, FeedItems, hasRunningAction } from '../../features/thread-feed/ThreadFeed.tsx';
import { fileHref } from '../../features/thread-feed/project.ts';
import { makeSelectFeedItems, makeSelectStartedHeadless } from '../../features/thread-feed/selectors.ts';
import { Composer } from '../../ui/Composer/Composer.tsx';
import { ComposerLock } from '../../ui/Composer/ComposerLock.tsx';
import { Empty } from '../../ui/Empty/Empty.tsx';
import { Feed } from '../../ui/Feed/Feed.tsx';
import { Icon } from '../../ui/Icon/Icon.tsx';
import { Link } from '../../lib/router/Link.tsx';
import { LoadMore } from '../../ui/List/List.tsx';
import { Md } from '../../ui/Md/Md.tsx';
import { Note } from '../../ui/Note/Note.tsx';
import { Screen } from '../../ui/Screen/Screen.tsx';
import { SkelStack } from '../../ui/Skel/Skel.tsx';
import { Summary } from '../../ui/Summary/Summary.tsx';
import { SysLine } from '../../ui/SysLine/SysLine.tsx';
import { Thread, ThreadBody, ThreadMain } from '../../ui/Thread/Thread.tsx';
import { ThreadHead } from '../../ui/ThreadHead/ThreadHead.tsx';
import { Code } from '../../ui/atoms/atoms.tsx';
import { ThreadMore } from './ThreadMore.tsx';
import { ThreadRail } from './ThreadRail.tsx';
import { railSessionInfo } from './rail.ts';
import { composerLock, feedStage, feedTop, threadTimeLabel } from './ThreadScreen.logic.ts';
import './ThreadScreen.css';

const SKELETON = [
  [30, 90, 70],
  [25, 60],
  [30, 85, 55],
];

const ENGINE: Record<string, string> = { claude: 'Claude', codex: 'Codex' };

function FeedSkeleton() {
  return (
    <div className="ths-skel" aria-hidden="true">
      {SKELETON.map((widths, i) => (
        <SkelStack key={i} widths={widths} smFirst />
      ))}
    </div>
  );
}

function scrollBox(node: HTMLElement | null): HTMLElement | null {
  return node?.closest('.shell-body') ?? null;
}

// The top of the feed in view asks for the earlier chunk.
function useTopSentinel(onVisible: () => void): (node: HTMLDivElement | null) => void {
  const observer = useRef<IntersectionObserver | null>(null);
  const callback = useRef(onVisible);

  callback.current = onVisible;

  return useCallback((node: HTMLDivElement | null) => {
    observer.current?.disconnect();
    observer.current = null;

    if (node) {
      observer.current = new IntersectionObserver(entries => {
        if (entries.some(entry => entry.isIntersecting)) {
          callback.current();
        }
      });
      observer.current.observe(node);
    }
  }, []);
}

// Keeps the reader's place: the first view of a feed opens at its end; an
// earlier chunk prepended above leaves the same event under the eye; a new
// event appended while the end is in view scrolls to it.
function useFeedScroll(feedRef: { current: HTMLDivElement | null }, ready: boolean, firstKey: string | null, lastKey: string | null, count: number): void {
  const last = useRef<{ height: number; first: string | null; last: string | null } | null>(null);
  const atEnd = useRef(true);
  const opened = useRef(false);

  useEffect(() => {
    const box = scrollBox(feedRef.current);

    if (!box) {
      return;
    }

    const onScroll = () => {
      atEnd.current = box.scrollHeight - box.scrollTop - box.clientHeight < 48;
    };

    box.addEventListener('scroll', onScroll, { passive: true });

    return () => box.removeEventListener('scroll', onScroll);
  }, [feedRef, ready]);

  useLayoutEffect(() => {
    const box = scrollBox(feedRef.current);

    if (!box || !ready) {
      return;
    }

    const previous = last.current;

    if (!opened.current) {
      opened.current = true;
      // After every effect of the shell (it resets a new screen to the top).
      requestAnimationFrame(() => {
        box.scrollTop = box.scrollHeight;
        atEnd.current = true;
      });
    } else if (previous && previous.first !== firstKey && previous.last === lastKey) {
      box.scrollTop += box.scrollHeight - previous.height;
    } else if (previous && previous.last !== lastKey && atEnd.current) {
      box.scrollTop = box.scrollHeight;
    }

    last.current = { height: box.scrollHeight, first: firstKey, last: lastKey };
  }, [feedRef, ready, firstKey, lastKey, count]);
}

function ThreadPage({ thread }: { thread: ThreadRecord }) {
  const dispatch = useAppDispatch();
  const id = thread.id;
  const state = useAppSelector(s => selectThreadState(s, id)) ?? 'wait';
  const session = useAppSelector(s => selectSession(s, id));
  const me = useAppSelector(selectMe);
  const parent = useAppSelector(s => (thread.parentId ? (s.threads.byId[thread.parentId] ?? null) : null));
  const childIds = useAppSelector(s => s.threads.childrenOf[id]) ?? [];
  const agentView = useAppSelector(s => s.agents.byName[thread.agent]);
  const project = useAppSelector(s => (thread.projectId ? (s.projects.byId[thread.projectId] ?? null) : null));
  const feed = useAppSelector(s => selectThreadFeed(s, id));
  const selectEvents = useMemo(makeSelectThreadEvents, []);
  const selectItems = useMemo(makeSelectFeedItems, []);
  const selectStartedHeadless = useMemo(makeSelectStartedHeadless, []);
  const events = useAppSelector(s => selectEvents(s, id));
  const items = useAppSelector(s => selectItems(s, id));
  const startedHeadless = useAppSelector(s => selectStartedHeadless(s, id));
  const draft = useAppSelector(s => selectComposerDraft(s, id));
  const sending = useAppSelector(s => selectComposerSending(s, id));
  const running = hasRunningAction(items);
  const now = useNow(running ? 1000 : undefined);
  const [moreOpen, setMoreOpen] = useState(false);

  const headless = startedHeadless ?? agentView?.headless ?? false;
  const info = useMemo(() => railSessionInfo(events, session?.context ?? null), [events, session]);
  const stage = feedStage(feed, events.length);
  const top = feedTop(feed);
  const ready = stage === 'ready';

  const loadEarlier = useCallback(() => {
    if (feed.knownFrom !== null && !feed.exhausted && !feed.request && !feed.error) {
      dispatch(loadThreadEvents(id, feed.knownFrom));
    }
  }, [dispatch, id, feed.knownFrom, feed.exhausted, feed.request, feed.error]);
  const topRef = useTopSentinel(loadEarlier);
  const retry = () => dispatch(loadThreadEvents(id, feed.knownFrom));

  const feedRef = useRef<HTMLDivElement>(null);

  useFeedScroll(feedRef, ready, items[0]?.key ?? null, items[items.length - 1]?.key ?? null, items.length);

  const lock = composerLock(thread, headless);
  const title = threadTitle(thread);
  const meta = [
    thread.agent,
    ...(parent ? [<>from <Link route={{ key: 'thread', id: parent.id }}>{parent.agent}</Link></>] : []),
    ...(project ? [<>project <Link route={{ key: 'project', slug: project.slug }}>{project.title}</Link></>] : []),
    threadTimeLabel(thread, state, now),
  ];
  const ctx = ctxOf(session);

  let topLine = null;

  if (top === 'complete') {
    topLine = <SysLine>Feed · {countOf(events.length, 'event')}</SysLine>;
  } else if (top === 'error' && feed.error) {
    topLine = (
      <Note state="err" icon="cloud-off" role="alert" action="Retry" actionIcon="refresh-cw" onAction={retry}>
        Couldn’t load earlier events: {feed.error.message}
      </Note>
    );
  } else {
    topLine = (
      <div ref={topRef} className="ths-top">
        <LoadMore>{top === 'loading' ? 'Loading earlier events…' : 'Earlier events'}</LoadMore>
      </div>
    );
  }

  return (
    <Shell current="threads" title={title} crumb={{ label: 'Threads', route: { key: 'threads' } }} back={{ key: 'threads' }} detail compact pageHead>
      <Thread className="ths">
        <ThreadHead
          agent={thread.agent}
          title={title}
          state={state}
          ctx={ctx}
          tag={headless ? 'headless' : undefined}
          links={
            childIds.length > 0 ? (
              <a
                className="link"
                href="#links"
                onClick={event => {
                  event.preventDefault();
                  setMoreOpen(true);
                }}
              >
                <Icon name="git-fork" />
                {countOf(childIds.length, 'child', 'children')}
              </a>
            ) : undefined
          }
          meta={meta}
          more={<ThreadMore thread={thread} parent={parent} childIds={childIds} open={moreOpen} onOpenChange={setMoreOpen} />}
        />
        <ThreadBody>
          <ThreadMain>
            <div ref={feedRef} style={{ display: 'contents' }}>
              <Feed align="end">
                {thread.status === 'completed' && thread.summary ? (
                  <Summary time={dateTimeLabel(thread.updatedAt, now)}>
                    <Md source={thread.summary.text} />
                    <Attachments atts={(thread.summary.fileIds ?? []).map((fileId, i) => ({ key: `s${i}`, href: fileHref(fileId), name: 'file', image: false, size: null }))} />
                  </Summary>
                ) : null}
                {stage === 'skeleton' ? <FeedSkeleton /> : null}
                {stage === 'failed' && feed.error ? (
                  <Empty icon="cloud-off" state="err" title="Couldn’t load the feed" action="Retry" actionIcon="refresh-cw" onAction={retry}>
                    {feed.error.message}
                  </Empty>
                ) : null}
                {ready ? (
                  <>
                    {topLine}
                    <FeedItems items={items} now={now} />
                  </>
                ) : null}
              </Feed>
            </div>
            {lock ? (
              <ComposerLock icon={lock.icon}>
                {lock.strong ? <strong>{lock.strong}</strong> : null}
                {lock.text}
              </ComposerLock>
            ) : (
              <Composer to={thread.agent} value={draft} onChange={text => dispatch(setComposerDraft(id, text))} onSend={text => dispatch(sendMessage(id, text))} busy={sending} />
            )}
          </ThreadMain>
          <ThreadRail
            thread={thread}
            state={state}
            engine={agentView ? (ENGINE[agentView.sdk] ?? agentView.sdk) : null}
            info={info}
            parent={parent}
            mainThreadId={me?.mainThreadId ?? null}
            childIds={childIds}
            project={project ? { slug: project.slug, title: project.title } : null}
            now={now}
          />
        </ThreadBody>
      </Thread>
    </Shell>
  );
}

export function ThreadScreen({ id }: { id: string }) {
  const dispatch = useAppDispatch();
  const thread = useAppSelector(s => selectThread(s, id));
  const lookup = useAppSelector(s => s.threads.lookup[id]);

  if (thread) {
    return <ThreadPage thread={thread} />;
  }

  const shell = { current: 'threads' as const, title: 'Thread', crumb: { label: 'Threads', route: { key: 'threads' as const } }, back: { key: 'threads' as const }, detail: true, compact: true, pageHead: true };

  if (lookup?.error) {
    const missing = lookup.error.status === 404;

    return (
      <Shell {...shell}>
        <Screen>
          <Empty
            icon={missing ? 'message-circle-question' : 'cloud-off'}
            state={missing ? undefined : 'err'}
            title={missing ? 'Thread not found' : 'Couldn’t load the thread'}
            action={missing ? undefined : 'Retry'}
            actionIcon={missing ? undefined : 'refresh-cw'}
            onAction={missing ? undefined : () => dispatch(loadThread(id))}
          >
            {missing ? (
              <>
                There is no thread <Code wrap>{id}</Code> in this workspace.
              </>
            ) : (
              lookup.error.message
            )}
          </Empty>
        </Screen>
      </Shell>
    );
  }

  return (
    <Shell {...shell}>
      <Thread className="ths">
        <ThreadHead agent="" title="" state="wait" loading />
        <ThreadBody>
          <ThreadMain>
            <Feed>
              <FeedSkeleton />
            </Feed>
          </ThreadMain>
        </ThreadBody>
      </Thread>
    </Shell>
  );
}
