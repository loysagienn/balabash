// Loading threads and their feeds through the Api. A result is dispatched
// only if the store still waits for exactly that request (same filters,
// same cursor); anything else is a stale answer and is dropped.

import { toApiFailure } from '../../lib/api/index.ts';
import type { ActionHandler } from '../types.ts';
import { pushToast } from '../ui/actions.ts';
import { commandThreadDone, commandThreadFail, loadThreadDone, loadThreadEventsDone, loadThreadEventsFail, loadThreadFail, loadThreadsDone, loadThreadsFail, sendMessageDone, sendMessageFail } from './actions.ts';

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

export const loadThreadHandler: ActionHandler<'LOAD_THREAD'> =
  ({ api, dispatch, getState, next }) =>
  async action => {
    if (getState().threads.lookup[action.id]?.loading) {
      return;
    }

    next(action);

    try {
      const { thread } = await api.threads.get(action.id);

      dispatch(loadThreadDone(action.id, thread));
    } catch (error) {
      dispatch(loadThreadFail(action.id, toApiFailure(error)));
    }
  };

// The message itself comes back as event/user.message through the tail;
// here only the request's fate: the draft clears on success, a failure
// keeps it and tells the user why.
export const sendMessageHandler: ActionHandler<'SEND_MESSAGE'> =
  ({ api, dispatch, getState, next }) =>
  async action => {
    if (getState().ui.composerSending[action.threadId]) {
      return;
    }

    next(action);

    try {
      await api.threads.sendMessage(action.threadId, action.text);
      dispatch(sendMessageDone(action.threadId));
    } catch (error) {
      const failure = toApiFailure(error);

      dispatch(sendMessageFail(action.threadId, failure));
      dispatch(pushToast({ title: 'Message not sent', desc: failure.message, state: 'err' }));
    }
  };

const COMMAND_FAILED_WORDS = { interrupt: 'Couldn’t stop the turn', cancel: 'Couldn’t cancel the thread' };

export const commandThreadHandler: ActionHandler<'COMMAND_THREAD'> =
  ({ api, dispatch, getState, next }) =>
  async action => {
    const { threadId, command } = action;

    if (getState().ui.threadCommands[threadId]?.[command]) {
      return;
    }

    next(action);

    try {
      if (command === 'interrupt') {
        await api.threads.interrupt(threadId);
      } else {
        await api.threads.cancel(threadId, action.reason);
      }

      dispatch(commandThreadDone(threadId, command));
    } catch (error) {
      const failure = toApiFailure(error);

      dispatch(commandThreadFail(threadId, command, failure));
      dispatch(pushToast({ title: COMMAND_FAILED_WORDS[command], desc: failure.message, state: 'err' }));
    }
  };
