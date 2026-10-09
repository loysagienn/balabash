// The feed items of a thread from the store: the thread's events in seq
// order (store/feed) through projectFeed, memoised per thread on the seq
// list and on the context (the thread's agent, its parent's, the agents of
// the threads the store knows — compared by content, so a thread's
// updatedAt bump does not re-project the feed — and the operator's name).

import { createSelector } from 'reselect';
import type { EventOf } from '../../../core/event-types.ts';
import { makeSelectThreadEvents } from '../../store/feed/selectors.ts';
import { selectOperatorName } from '../../store/session/selectors.ts';
import type { State } from '../../store/types.ts';
import { projectFeed } from './project.ts';
import type { FeedContext, FeedItem } from './project.ts';

let agentsCache: { byId: State['threads']['byId']; map: Map<string, string> } | null = null;

// id → agent of every thread the store knows; the same Map while the pairs
// are the same.
export function selectThreadAgents(state: State): Map<string, string> {
  const { byId } = state.threads;

  if (agentsCache && agentsCache.byId === byId) {
    return agentsCache.map;
  }

  const map = new Map<string, string>();

  for (const thread of Object.values(byId)) {
    map.set(thread.id, thread.agent);
  }

  let same = agentsCache !== null && agentsCache.map.size === map.size;

  if (same && agentsCache) {
    for (const [id, agent] of map) {
      if (agentsCache.map.get(id) !== agent) {
        same = false;
        break;
      }
    }
  }

  const result = same && agentsCache ? agentsCache.map : map;

  agentsCache = { byId, map: result };

  return result;
}

const selectFeedContext = createSelector(
  [(state: State, threadId: string) => threadId, (state: State, threadId: string) => state.threads.byId[threadId]?.agent ?? 'agent', (state: State, threadId: string) => state.threads.byId[threadId]?.parentId ?? null, selectThreadAgents, selectOperatorName],
  (threadId, agent, parentId, agents, you): FeedContext => ({
    threadId,
    agent,
    parentAgent: parentId ? (agents.get(parentId) ?? 'parent') : null,
    agentOf: id => agents.get(id) ?? null,
    you,
  }),
);

export const makeSelectFeedItems = () => createSelector([makeSelectThreadEvents(), selectFeedContext], (events, ctx): FeedItem[] => projectFeed(events, ctx));

// Whether the thread is headless by its own thread.started (when loaded);
// null when the feed has not reached it — the agent catalog decides then.
export const makeSelectStartedHeadless = () =>
  createSelector([makeSelectThreadEvents(), (state: State, threadId: string) => threadId], (events, threadId): boolean | null => {
    const started = events.find((event): event is EventOf<'thread.started'> => event.type === 'thread.started' && event.threadId === threadId);

    return started ? (typeof started.payload.headless === 'boolean' ? started.payload.headless : null) : null;
  });
