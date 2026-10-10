// One thread of a list, connected to the store: the thread's state (rule
// 4), its session's context ring, the project's title, the number of child
// threads the store knows, the thread's own headless policy and the last
// action among the thread's loaded events — all turned into the words of
// ui/ThreadRow by rowData.ts. The row is a link to the thread. The pinned
// main thread shows its last message instead: the newest among its loaded
// events or the one the snapshot carried (selectors.ts).

import { useMemo } from 'react';
import type { Thread } from '../../../core/contract.ts';
import { useLinkProps } from '../../lib/router/Link.tsx';
import { useAppSelector } from '../../store/hooks.ts';
import { makeSelectThreadEvents } from '../../store/feed/selectors.ts';
import { selectSession, selectThreadState } from '../../store/sessions/selectors.ts';
import { selectChildCount } from '../../store/threads/selectors.ts';
import { ThreadRow } from '../../ui/ThreadRow/ThreadRow.tsx';
import { isActiveState } from '../../ui/ThreadRow/ThreadRow.logic.ts';
import { lastActionOf } from './lastAction.ts';
import { threadRowData } from './rowData.ts';
import { makeSelectLastMessage } from './selectors.ts';

export type ThreadListRowProps = {
  thread: Thread;
  now: Date;
  hit?: string;
  fresh?: boolean;
  current?: boolean;
  noAgent?: boolean;
  // The pinned main thread: a pin instead of the state, its last loaded
  // message instead of the last action, without a children count.
  main?: boolean;
};

const NO_EVENTS: never[] = [];

export function ThreadListRow({ thread, now, hit, fresh, current, noAgent, main }: ThreadListRowProps) {
  const state = useAppSelector(s => selectThreadState(s, thread.id)) ?? 'wait';
  const session = useAppSelector(s => selectSession(s, thread.id));
  const project = useAppSelector(s => (thread.projectId ? (s.projects.byId[thread.projectId]?.title ?? null) : null));
  const kids = useAppSelector(s => selectChildCount(s, thread.id));
  const selectEvents = useMemo(makeSelectThreadEvents, []);
  const active = isActiveState(state);
  const events = useAppSelector(s => (active ? selectEvents(s, thread.id) : NO_EVENTS));
  const selectLastMessage = useMemo(makeSelectLastMessage, []);
  const last = useMemo(() => (active && !main ? lastActionOf(events) : null), [active, main, events]);
  const lastMessage = useAppSelector(s => (main ? selectLastMessage(s, thread.id) : null));
  const link = useLinkProps({ key: 'thread', id: thread.id });
  const data = threadRowData({ thread, state, session, project, kids, headless: thread.headless, last, now, ...(main ? { main, lastMessage } : {}) });

  return <ThreadRow {...data} {...link} hit={hit} fresh={fresh} current={current} noAgent={noAgent} />;
}
