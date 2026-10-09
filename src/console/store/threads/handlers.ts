// Loading threads and their feeds through the Api. A result is dispatched
// only if the store still waits for exactly that request (same filters,
// same cursor); anything else is a stale answer and is dropped.

import { toApiFailure } from '../../lib/api/index.ts';
import type { ActionHandler } from '../types.ts';
import { loadThreadEventsDone, loadThreadEventsFail, loadThreadsDone, loadThreadsFail } from './actions.ts';

export const THREADS_PAGE = 50;
export const FEED_CHUNK = 500;

export const loadThreadsHandler: ActionHandler<'LOAD_THREADS'> =
  ({ api, dispatch, getState, next }) =>
  async action => {
    next(action);

    const { filters, before } = action;

    try {
      const page = await api.threads.list({
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.projectId ? { projectId: filters.projectId } : {}),
        ...(before !== null ? { before: before.toString() } : {}),
        limit: THREADS_PAGE,
      });

      if (getState().threads.list.filters !== filters) {
        return;
      }

      dispatch(loadThreadsDone(filters, before, page.threads, page.nextCursor));
    } catch (error) {
      dispatch(loadThreadsFail(filters, before, toApiFailure(error)));
    }
  };

export const loadThreadEventsHandler: ActionHandler<'LOAD_THREAD_EVENTS'> =
  ({ api, dispatch, getState, next }) =>
  async action => {
    const { threadId, before } = action;
    const { asOfSeq } = getState().stream;

    if (asOfSeq === null) {
      return;
    }

    next(action);

    try {
      const page = await api.threads.events(threadId, { before: before ?? asOfSeq + 1n, limit: FEED_CHUNK });

      if (getState().feed.byThread[threadId]?.request?.before !== before) {
        return;
      }

      dispatch(loadThreadEventsDone(threadId, before, page.events, page.nextCursor));
    } catch (error) {
      dispatch(loadThreadEventsFail(threadId, before, toApiFailure(error)));
    }
  };
