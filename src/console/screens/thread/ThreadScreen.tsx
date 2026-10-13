// Thread — the feed of three weights (features/thread-feed) with the
// summary of a finished thread first, the composer pinned to the bottom,
// and what the page says about the thread: wide (> 900) — the right rail
// pinned beside the feed, the title in the shell header; narrow — the glass
// strip pinned on top, the rail's content in the "⋯" sheet; on the phone
// the strip is the screen header (Shell ownTop). The feed is the store's
// projection of the thread's events, and the page draws only its end:
// earlier items are drawn as the reader nears the top, and when every
// loaded item is drawn the next chunk loads (the scroll position stays on
// the same item); the tail appends live. A thread outside the snapshot
// window is fetched by id first.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Thread as ThreadRecord } from '../../../core/contract.ts';
import { countOf, dateTimeLabel } from '../../lib/format/index.ts';
import { useNow } from '../../lib/format/useNow.ts';
import { useAppDispatch, useAppSelector } from '../../store/hooks.ts';
import { selectAgent } from '../../store/agents/selectors.ts';
import { engineLabel } from '../../lib/format/engine.ts';
import { makeSelectThreadEvents, selectThreadFeed } from '../../store/feed/selectors.ts';
import { routeTo } from '../../store/router/actions.ts';
import { selectSession, selectThreadState } from '../../store/sessions/selectors.ts';
import { commandThread, loadThread, loadThreadEvents } from '../../store/threads/actions.ts';
import { selectThread } from '../../store/threads/selectors.ts';
import { selectThreadCommandPending } from '../../store/ui/selectors.ts';
import { Shell } from '../../features/shell/Shell.tsx';
import { threadTitle, ctxOf } from '../../features/thread-list/rowData.ts';
import { Attachments, FeedItems, hasRunningAction } from '../../features/thread-feed/ThreadFeed.tsx';
import { fileIdAtts } from '../../features/thread-feed/project.ts';
import { makeSelectFeedItems } from '../../features/thread-feed/selectors.ts';
import { Drop } from '../../ui/Drop/Drop.tsx';
import type { DropPlace } from '../../ui/Drop/Drop.tsx';
import { useFileDrop } from '../../lib/upload/useFileDrop.ts';
import { Confirm } from '../../ui/Confirm/Confirm.tsx';
import { Empty } from '../../ui/Empty/Empty.tsx';
import { Feed } from '../../ui/Feed/Feed.tsx';
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
import { ThreadDetailsSheet, ThreadRail } from './ThreadRail.tsx';
import { ThreadComposer, useAttach } from './ThreadComposer.tsx';
import type { ThreadDetailCommands } from './ThreadRail.tsx';
import { railSessionInfo } from './rail.ts';
import {
  anchorIndex,
  cancelWords,
  finishWords,
  composerLock,
  feedScrollMove,
  feedStage,
  feedTop,
  feedWindowStart,
  isNearTop,
  nearTopAction,
  openFeedWindow,
  revealEarlier,
  settleFeedWindow,
  threadCommands,
} from './ThreadScreen.logic.ts';
import type { FeedScrollSeen, FeedWindow } from './ThreadScreen.logic.ts';
import type { FeedItem } from '../../features/thread-feed/project.ts';
import './ThreadScreen.css';

const SKELETON = [
  [30, 90, 70],
  [25, 60],
  [30, 85, 55],
];

const BACK = { key: 'threads' } as const;

function FeedSkeleton() {
  return (
    <div className="ths-skel" aria-hidden="true">
      {SKELETON.map((widths, i) => (
        <SkelStack key={i} widths={widths} smFirst />
      ))}
    </div>
  );
}

// The part of an element inside the window and its scroll box — where a
// frame over it can be seen.
function visiblePlace(node: HTMLElement | null): DropPlace | undefined {
  if (!node) {
    return undefined;
  }

  const rect = node.getBoundingClientRect();
  const box = scrollBox(node)?.getBoundingClientRect();
  const top = Math.max(rect.top, box?.top ?? 0, 0);
  const bottom = Math.min(rect.bottom, box?.bottom ?? window.innerHeight, window.innerHeight);

  return { top, left: rect.left, width: rect.width, height: Math.max(0, bottom - top) };
}

function scrollBox(node: HTMLElement | null): HTMLElement | null {
  return node?.closest('.shell-body') ?? null;
}

// The offset of a node from the top of the scroll box's content — the same
// number wherever the box is scrolled.
function offsetIn(box: HTMLElement, node: Element): number {
  return node.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
}

// The first drawn item of each thread's feed the page was left with: a
// history navigation back to the thread draws the feed from there, so the
// place the shell brings back (the router's scroll) is over the same items.
const feedPlaces = new Map<string, string>();

type FeedAnchor = { node: Element; offset: number };

type FeedScrollInput = {
  feedRef: { current: HTMLDivElement | null };
  itemsRef: { current: HTMLDivElement | null };
  topRef: { current: HTMLDivElement | null };
  ready: boolean;
  drawn: FeedItem[];
  // What sits at the top of the drawn feed: a change there is a change
  // above the eye (feedScrollMove).
  top: string;
  requesting: boolean;
  restore: number | null;
  // Draws or loads more; true when earlier items go in at the next render.
  onNearTop: () => boolean;
};

// Keeps the reader's place (the rule is feedScrollMove): the first view of a
// feed opens at its end — at the place history brought back (`restore`)
// when there is one; items drawn above — earlier items revealed, an earlier
// chunk landed — leave the same item under the eye: by the shift of the
// item under the top of the view (anchorIndex), or the nearest one below
// it still in the DOM: a chunk can re-key items between the top of the
// feed and the eye (older actions merge into the first group, a card whose
// start arrives moves up to it), so no item further up is a safe measure.
// The items are measured while a chunk is in flight — the heights of the
// moment it lands — and right before earlier items are revealed
// (`remember`). A change while the end is in view scrolls to it, a new row
// inside the last group included. Native scroll anchoring is off for the
// feed (ThreadScreen.css), so this is the only hand on the box. After every
// change and on scroll, a reader less than a screen from the top of the
// drawn feed asks for more (onNearTop). Returns whether the feed has
// scrolled under the thread's strip.
function useFeedScroll({ feedRef, itemsRef, topRef, ready, drawn, top, requesting, restore, onNearTop }: FeedScrollInput): boolean {
  const seen = useRef<(FeedScrollSeen & { anchors: FeedAnchor[] }) | null>(null);
  const atEnd = useRef(true);
  const scrollTop = useRef(0);
  const nearTop = useRef(onNearTop);
  const [stuck, setStuck] = useState(false);

  nearTop.current = onNearTop;

  const measure = useCallback((box: HTMLElement): FeedAnchor[] => Array.from(itemsRef.current?.children ?? []).map(node => ({ node, offset: offsetIn(box, node) })), [itemsRef]);

  const checkTop = useCallback(() => {
    const box = scrollBox(feedRef.current);
    const sentinel = topRef.current;

    if (!box || !sentinel) {
      return;
    }

    // Earlier items go in above the eye at the next render: the place is
    // measured now, before it (a chunk in flight is measured at every change).
    if (isNearTop(sentinel.getBoundingClientRect().bottom, box.getBoundingClientRect().top, box.clientHeight) && nearTop.current() && seen.current) {
      seen.current.anchors = measure(box);
    }
  }, [feedRef, topRef, measure]);

  useEffect(() => {
    const box = scrollBox(feedRef.current);

    if (!box) {
      return undefined;
    }

    let frame = 0;
    const onScroll = () => {
      scrollTop.current = box.scrollTop;
      atEnd.current = box.scrollHeight - box.scrollTop - box.clientHeight < 48;
      setStuck(box.scrollTop > 0);

      if (!frame) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          checkTop();
        });
      }
    };

    box.addEventListener('scroll', onScroll, { passive: true });

    return () => {
      box.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(frame);
    };
  }, [feedRef, ready, checkTop]);

  // The drawn items keep growing after they are placed — the Markdown
  // renderer arrives, an image loads, details open: a reader at the end
  // stays at the end (the feed opens there and the tail follows it).
  useEffect(() => {
    const box = scrollBox(feedRef.current);
    const content = feedRef.current?.firstElementChild;

    if (!box || !content || !ready) {
      return undefined;
    }

    const observer = new ResizeObserver(() => {
      const last = seen.current;

      if (!last) {
        return;
      }
      if (last.height - box.scrollTop - box.clientHeight < 48 && box.scrollHeight !== last.height) {
        box.scrollTop = box.scrollHeight;
        scrollTop.current = box.scrollTop;
        atEnd.current = true;
      }

      last.height = box.scrollHeight;
    });

    observer.observe(content);

    return () => observer.disconnect();
  }, [feedRef, ready]);

  useLayoutEffect(() => {
    const box = scrollBox(feedRef.current);

    if (!box || !ready) {
      return;
    }

    const previous = seen.current;
    // Whether the end was in view before this change, from the box as it is
    // now: a scroll the box has not reported yet counts (its event comes at
    // the next frame, and a row landing in between must not pull the reader
    // back to the end).
    const wasAtEnd = previous ? previous.height - box.scrollTop - box.clientHeight < 48 : atEnd.current;
    const anchors = previous?.anchors ?? [];
    const anchor = anchors.slice(anchorIndex(anchors.map(candidate => candidate.offset), scrollTop.current)).find(candidate => candidate.node.isConnected);
    const move = feedScrollMove({
      previous,
      top,
      atEnd: wasAtEnd,
      anchorShift: anchor ? offsetIn(box, anchor.node) - anchor.offset : null,
      height: box.scrollHeight,
      restore,
    });
    const toEnd = () => {
      box.scrollTop = box.scrollHeight;
      scrollTop.current = box.scrollTop;
      atEnd.current = true;
    };
    const to = (px: number) => {
      box.scrollTop = px;
      scrollTop.current = box.scrollTop;
      atEnd.current = box.scrollHeight - box.scrollTop - box.clientHeight < 48;
    };

    if (move?.kind === 'open') {
      toEnd();
      // Again after every effect of the shell (it resets a new screen to the top).
      requestAnimationFrame(toEnd);
    } else if (move?.kind === 'to') {
      to(move.px);
      requestAnimationFrame(() => to(move.px));
    } else if (move?.kind === 'end') {
      toEnd();
    } else if (move?.kind === 'by') {
      box.scrollTop += move.px;
      scrollTop.current = box.scrollTop;
    }

    setStuck(box.scrollTop > 0);

    // Measured while a chunk is in flight: it lands at the next change.
    seen.current = { top, height: box.scrollHeight, anchors: requesting ? measure(box) : [] };

    // A short drawn feed, or a reader already near its top: draw more.
    checkTop();
  }, [feedRef, ready, drawn, top, requesting, restore, measure, checkTop]);

  return stuck;
}

function ThreadPage({ thread }: { thread: ThreadRecord }) {
  const dispatch = useAppDispatch();
  const id = thread.id;
  const state = useAppSelector(s => selectThreadState(s, id)) ?? 'wait';
  const session = useAppSelector(s => selectSession(s, id));
  const parent = useAppSelector(s => (thread.parentId ? (s.threads.byId[thread.parentId] ?? null) : null));
  const agentView = useAppSelector(s => selectAgent(s, thread.agent));
  const project = useAppSelector(s => (thread.projectId ? (s.projects.byId[thread.projectId] ?? null) : null));
  const feed = useAppSelector(s => selectThreadFeed(s, id));
  const selectEvents = useMemo(makeSelectThreadEvents, []);
  const selectItems = useMemo(makeSelectFeedItems, []);
  const events = useAppSelector(s => selectEvents(s, id));
  const items = useAppSelector(s => selectItems(s, id));
  const [detailsOpen, setDetailsOpen] = useState(false);

  // "Stop turn" and "Cancel thread": the commands go up as COMMAND_THREAD,
  // the outcome comes back with the tail (thread.cancelled ends the thread
  // and the buttons with it). A cancel asks first (rule 13).
  const commands = threadCommands(thread, state);
  const stopping = useAppSelector(s => selectThreadCommandPending(s, id, 'interrupt'));
  const cancelling = useAppSelector(s => selectThreadCommandPending(s, id, 'cancel'));
  const finishing = useAppSelector(s => selectThreadCommandPending(s, id, 'finish'));
  const pausing = useAppSelector(s => selectThreadCommandPending(s, id, 'pause'));
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [confirmFinish, setConfirmFinish] = useState(false);
  const stop = () => dispatch(commandThread(id, 'interrupt'));
  const askCancel = () => setConfirmCancel(true);
  const cancel = () => {
    setConfirmCancel(false);
    dispatch(commandThread(id, 'cancel'));
  };
  // A remote thread: Finish asks first (like Cancel — the thread ends);
  // Pause acts at once.
  const askFinish = () => setConfirmFinish(true);
  const finish = () => {
    setConfirmFinish(false);
    dispatch(commandThread(id, 'finish'));
  };
  const pause = () => dispatch(commandThread(id, 'pause'));

  useEffect(() => {
    if (!commands.running) {
      setConfirmCancel(false);
      setConfirmFinish(false);
    }
  }, [commands.running]);

  const info = useMemo(() => railSessionInfo(events, session?.context ?? null, session?.started ?? null), [events, session]);
  const stage = feedStage(feed, events.length);
  const ready = stage === 'ready';

  // The place history brought the thread back with (the shell restores it
  // for every screen; the feed opens there instead of at its end).
  const restore = useAppSelector(s => (s.router.source === 'history' ? s.router.scroll : null));

  // The drawn part of the feed (FeedWindow): the end at first, earlier
  // items as the reader nears the top. Settled while rendering, so a chunk
  // that lands draws its first part in the same commit.
  const keys = useMemo(() => items.map(item => item.key), [items]);
  const [win, setWin] = useState<FeedWindow>(() => openFeedWindow(feed.knownFrom, restore !== null ? (feedPlaces.get(id) ?? null) : null));
  const settled = settleFeedWindow(keys, win, feed.knownFrom, feed.knownFrom !== null || feed.exhausted);

  if (settled !== win) {
    setWin(settled);
  }

  const start = feedWindowStart(keys, settled);
  const drawn = useMemo(() => (start > 0 ? items.slice(start) : items), [items, start]);

  useEffect(() => {
    if (settled.key !== null) {
      feedPlaces.set(id, settled.key);
    }
  }, [id, settled.key]);

  const running = hasRunningAction(drawn);
  const now = useNow(running ? 1000 : undefined);

  const onNearTop = () => {
    const action = nearTopAction(start, feed);

    if (action === 'reveal') {
      setWin(current => revealEarlier(keys, current));
    } else if (action === 'load') {
      dispatch(loadThreadEvents(id, feed.knownFrom));
    }

    return action === 'reveal';
  };
  const retry = () => dispatch(loadThreadEvents(id, feed.knownFrom));

  const feedRef = useRef<HTMLDivElement>(null);
  const itemsRef = useRef<HTMLDivElement>(null);
  const topRef = useRef<HTMLDivElement>(null);
  const top = `${feed.knownFrom ?? ''}:${feed.exhausted}:${drawn[0]?.key ?? ''}`;
  const stuck = useFeedScroll({ feedRef, itemsRef, topRef, ready, drawn, top, requesting: feed.request !== null, restore, onNearTop });

  const lock = composerLock(thread);
  const title = threadTitle(thread);
  // Files dragged over the thread attach to the draft (a closed thread
  // takes none); the frame covers the part of the column in view.
  const attach = useAttach(id);
  const mainRef = useRef<HTMLDivElement>(null);
  const { drag, handlers: dropHandlers } = useFileDrop(lock === null, files => attach(files));
  const dropPlace = drag ? visiblePlace(mainRef.current) : undefined;
  // The live context of an active session, else the last one the loaded
  // events measured (a finished thread's final context, as in the rail).
  const ctx = ctxOf(session) ?? (info.context && info.context.max > 0 ? { percentage: (info.context.used / info.context.max) * 100, usedTokens: info.context.used, maxTokens: info.context.max } : undefined);
  const detailCommands: ThreadDetailCommands | null = commands.running
    ? {
        onStop: stop,
        stopBusy: stopping,
        stopDisabled: !commands.stopEnabled,
        onCancel: askCancel,
        cancelBusy: cancelling,
        ...(commands.remote ? { remote: { onFinish: askFinish, finishBusy: finishing, onPause: pause, pauseBusy: pausing, pauseDisabled: !commands.pauseEnabled } } : {}),
      }
    : null;
  const details = { thread, title, state, engine: agentView ? engineLabel(agentView.sdk) : null, info, parent, project: project ? { slug: project.slug, title: project.title } : null, commands: detailCommands, now };
  const feedState = start > 0 ? 'more' : feedTop(feed);

  let topLine = null;

  if (feedState === 'complete') {
    topLine = <SysLine>Feed · {countOf(events.length, 'event')}</SysLine>;
  } else if (feedState === 'error' && feed.error) {
    topLine = (
      <Note state="err" icon="cloud-off" role="alert" action="Retry" actionIcon="refresh-cw" onAction={retry}>
        Couldn’t load earlier events: {feed.error.message}
      </Note>
    );
  } else {
    topLine = (
      <div ref={topRef} className="ths-top">
        <LoadMore>{feedState === 'loading' ? 'Loading earlier events…' : 'Earlier events'}</LoadMore>
      </div>
    );
  }

  return (
    <Shell current="threads" title={title} crumb={{ label: 'Threads', route: BACK }} back={BACK} detail compact ownTop>
      <Thread className="ths">
        <ThreadHead
          title={title}
          state={state}
          ctx={ctx}
          tag={thread.headless ? 'headless' : undefined}
          stuck={stuck}
          onBack={() => dispatch(routeTo(BACK))}
          running={commands.running}
          onStop={stop}
          stopBusy={stopping}
          stopDisabled={!commands.stopEnabled}
          onCancel={askCancel}
          cancelBusy={cancelling}
          onMore={() => setDetailsOpen(open => !open)}
          moreOpen={detailsOpen}
        />
        {confirmCancel ? (
          <Confirm title="Cancel thread?" confirm="Cancel thread" confirmIcon="circle-stop" cancel="Keep running" onConfirm={cancel} onClose={() => setConfirmCancel(false)}>
            {cancelWords(thread)}
          </Confirm>
        ) : null}
        {confirmFinish ? (
          <Confirm title="Finish thread?" confirm="Finish thread" confirmIcon="check" cancel="Keep running" onConfirm={finish} onClose={() => setConfirmFinish(false)}>
            {finishWords(thread)}
          </Confirm>
        ) : null}
        {detailsOpen ? <ThreadDetailsSheet {...details} onClose={() => setDetailsOpen(false)} /> : null}
        <ThreadBody>
          <ThreadMain ref={mainRef} drop={dropHandlers}>
            <div ref={feedRef} style={{ display: 'contents' }}>
              <Feed align="end">
                {thread.status === 'completed' && thread.summary ? (
                  <Summary time={dateTimeLabel(thread.updatedAt, now)}>
                    <Md source={thread.summary.text} />
                    <Attachments atts={fileIdAtts(thread.summary.fileIds ?? [], 's')} context={`${thread.agent} · summary, ${dateTimeLabel(thread.updatedAt, now)}`} />
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
                    <div ref={itemsRef} style={{ display: 'contents' }}>
                      <FeedItems items={drawn} now={now} />
                    </div>
                  </>
                ) : null}
              </Feed>
            </div>
            <ThreadComposer thread={thread} lock={lock} />
            {drag ? <Drop label="Drop to attach to your message" sub={`${countOf(drag.count, 'file')} · to ${thread.agent}`} place={dropPlace} /> : null}
          </ThreadMain>
          <ThreadRail {...details} />
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
    // Keyed by the thread: a step straight from one thread to another starts
    // a fresh page — its own scroll place, feed opened at the end.
    return <ThreadPage key={thread.id} thread={thread} />;
  }

  const shell = { current: 'threads' as const, title: 'Thread', crumb: { label: 'Threads', route: BACK }, back: BACK, detail: true, compact: true };

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
    <Shell {...shell} ownTop>
      <Thread className="ths">
        <ThreadHead title="" state="wait" loading onBack={() => dispatch(routeTo(BACK))} />
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
