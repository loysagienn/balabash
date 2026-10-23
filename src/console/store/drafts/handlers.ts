// The requests of the drafts: the read of the server's draft, applied to
// the composer only while the tab has nothing unsaved of its own; the save
// over the revision the tab bases its content on, and what a refusal of
// that base means — the same content there (another device saved the very
// text; adopt the revision), an empty draft there (cleared by a send or an
// emptied composer elsewhere: this tab's text is the only one, saved again
// over the new revision — unless the text is the one this tab just sent
// and the clear is that send's: then the clear is adopted), another text
// there (a conflict — the tab keeps its own and asks the user).
// Last-writer-wins is never silent: text is only ever replaced by the
// user's choice. No save starts while a send is in flight: the send
// settles the draft.

import { ApiError, toApiFailure } from '../../lib/api/index.ts';
import type { DraftView } from '../../../api/contract.ts';
import { draftLoad, draftLoadDone, draftLoadFail, draftSaveConflict, draftSaveDone, draftSaveFail } from './actions.ts';
import { contentOf, emptyDraftSync, isDirty, isEmptyContent, sameContent, saveSpentBySend } from './reducer.ts';
import { draftContentOf } from './selectors.ts';
import type { ActionHandler } from '../types.ts';

// The draft a 409 draft_conflict carries (the server's current one; null —
// no row). An answer without it reads as an empty draft of revision 0.
export function conflictDraftOf(error: ApiError): DraftView | null {
  const draft = error.details?.draft;

  return typeof draft === 'object' && draft !== null && typeof (draft as DraftView).revision === 'number' ? (draft as DraftView) : null;
}

export const draftLoadHandler: ActionHandler<'DRAFT_LOAD'> =
  ({ api, dispatch, getState, next }) =>
  async action => {
    const { threadId } = action;

    if (getState().drafts.byThread[threadId]?.loading) {
      return;
    }

    next(action);

    try {
      const { draft } = await api.threads.draft(threadId);
      const sync = getState().drafts.byThread[threadId];
      // Typed meanwhile, or a save on its way: the tab's content stands,
      // its save will meet the server's revision.
      const applied = sync !== undefined && !sync.saving && !isDirty(sync) && sync.conflict === null;

      dispatch(draftLoadDone(threadId, draft, applied));
    } catch (error) {
      dispatch(draftLoadFail(threadId, toApiFailure(error)));
    }
  };

export const draftSaveHandler: ActionHandler<'DRAFT_SAVE'> =
  ({ api, dispatch, getState, next }) =>
  async action => {
    const { threadId } = action;
    const state = getState();
    const sync = state.drafts.byThread[threadId];

    if (!sync || sync.saving || sync.conflict || sync.sending !== null || !isDirty(sync)) {
      return;
    }

    next(action);

    const content = draftContentOf(state, threadId);

    // The server has this very content (a chip removed before its upload
    // ended, a file picked over the limit): nothing to write.
    if (sync.saved && sameContent(content, sync.saved)) {
      dispatch(draftSaveDone(threadId, sync.revision, content));

      return;
    }

    let base = sync.revision;

    for (let attempt = 0; ; attempt++) {
      try {
        const { draft } = await api.threads.saveDraft(threadId, content, base, { keepalive: action.keepalive });

        dispatch(draftSaveDone(threadId, draft?.revision ?? 0, content));

        return;
      } catch (error) {
        if (!(error instanceof ApiError) || error.code !== 'draft_conflict') {
          dispatch(draftSaveFail(threadId, toApiFailure(error)));

          return;
        }

        const server = conflictDraftOf(error);
        const theirs = contentOf(server);
        const revision = server?.revision ?? 0;

        if (sameContent(theirs, content)) {
          dispatch(draftSaveDone(threadId, revision, content));

          return;
        }

        // The save carried the text of a send that landed first: the empty
        // draft is that send's clear — adopted, the sent text not written
        // back (the composer is clearing with the send).
        if (isEmptyContent(theirs) && saveSpentBySend(getState().drafts.byThread[threadId] ?? emptyDraftSync)) {
          dispatch(draftSaveDone(threadId, revision, theirs));

          return;
        }

        // Cleared elsewhere (sent, emptied): nothing of the user's is on the
        // other side — this tab's content is saved over the new revision.
        if (isEmptyContent(theirs) && attempt === 0) {
          base = revision;

          continue;
        }

        dispatch(draftSaveConflict(threadId, server ?? { threadId, text: '', files: [], revision, updatedAt: new Date(0) }));

        return;
      }
    }
  };

// The stream's word that the draft moved on: read it again — only for a
// thread this tab has opened (one it tracks), and only past the revision
// the tab bases its content on (its own save's frame comes back too).
export const draftChangedRemotelyHandler: ActionHandler<'DRAFT_CHANGED_REMOTELY'> =
  ({ dispatch, getState, next }) =>
  action => {
    next(action);

    const sync = getState().drafts.byThread[action.threadId];

    if (sync && action.revision > sync.revision) {
      dispatch(draftLoad(action.threadId));
    }
  };

// The tail reopened after a break: the draft of the thread on screen may
// have moved on while the frames did not flow.
export const streamOpenedHandler: ActionHandler<'STREAM_OPENED'> =
  ({ dispatch, getState, next }) =>
  action => {
    const reconnected = getState().stream.status === 'reconnecting';

    next(action);

    const { route } = getState().router;

    if (reconnected && route.key === 'thread') {
      dispatch(draftLoad(route.id));
    }
  };
