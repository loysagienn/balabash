// From a thread of the store to the words of its row (ui/ThreadRow): an
// active one — "since 14:02 / running 2h 36m" and the context ring; a
// closed one — "13:17 → 13:59 / 42m" and its summary; the main thread —
// the pinned row "Main thread": a pin instead of the state, its last
// message (the time always, the words when it has any) when the store
// holds one, no ring, its
// children uncounted (the store knows a window of them, not all). Pure, so
// the mapping is tested
// without the store or the DOM; the connected row reads the pieces (state,
// session, project, children, agent policy, last action) and calls it.

import type { Thread } from '../../../core/contract.ts';
import type { SessionView } from '../../../projections/session.ts';
import { dateTimeLabel, durationLabel, rangeLabel, sinceLabel } from '../../lib/format/index.ts';
import { plainLine } from '../../lib/format/plain.ts';
import type { CtxInput } from '../../ui/Ring/Ring.logic.ts';
import type { ThreadRowProps } from '../../ui/ThreadRow/ThreadRow.tsx';
import type { StateName } from '../../ui/atoms/state.ts';
import { isActiveState } from '../../ui/ThreadRow/ThreadRow.logic.ts';
import type { LastAction, LastMessage } from './lastAction.ts';

export type ThreadRowInput = {
  thread: Thread;
  state: StateName;
  session: SessionView | null;
  project: string | null;
  kids: number;
  headless: boolean;
  last: LastAction | null;
  now: Date;
  main?: boolean;
  // The main thread's last loaded message (lastMessageOf); null — none yet.
  lastMessage?: LastMessage | null;
};

export type ThreadRowData = Omit<ThreadRowProps, 'href' | 'onClick' | 'current' | 'fresh' | 'hit' | 'noAgent'>;

export function ctxOf(session: SessionView | null): CtxInput | undefined {
  const context = session?.context;

  if (!context || context.max <= 0) {
    return undefined;
  }

  return { percentage: (context.used / context.max) * 100, usedTokens: context.used, maxTokens: context.max };
}

// The row title: the thread's title, or the agent's name while it has none.
export function threadTitle(thread: Thread): string {
  return thread.title?.trim() || thread.agent;
}

export function threadRowData({ thread, state, session, project, kids, headless, last, now, main, lastMessage }: ThreadRowInput): ThreadRowData {
  const base: ThreadRowData = {
    agent: thread.agent,
    title: main ? thread.title?.trim() || 'Main thread' : threadTitle(thread),
    state,
    ...(project ? { project } : {}),
    ...(headless ? { headless: true } : {}),
    ...(kids > 0 && !main ? { kids } : {}),
    time: '',
  };

  if (main) {
    return {
      ...base,
      pinned: true,
      ...(lastMessage ? { ...(lastMessage.text ? { last: lastMessage.text } : {}), time: dateTimeLabel(lastMessage.at, now) } : {}),
    };
  }

  if (isActiveState(state)) {
    return {
      ...base,
      ...(last?.lastCode ? { lastCode: last.lastCode } : last?.last ? { last: last.last } : {}),
      time: sinceLabel(thread.createdAt, now),
      sub: `running ${durationLabel(now.getTime() - thread.createdAt.getTime())}`,
      ...(ctxOf(session) ? { ctx: ctxOf(session) } : {}),
    };
  }

  // A description or a summary is written by an agent — Markdown marks
  // may be in it; the row shows plain words.
  const desc = plainLine(thread.description ?? '') || plainLine(thread.summary?.text ?? '');

  return {
    ...base,
    time: rangeLabel(thread.createdAt, thread.updatedAt, now),
    sub: durationLabel(thread.updatedAt.getTime() - thread.createdAt.getTime()),
    ...(desc ? { desc } : {}),
  };
}
