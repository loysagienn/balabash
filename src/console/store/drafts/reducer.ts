// The sync state of the composer's drafts against the server, per thread
// (the content itself lives where it always did: the text in
// ui.composerDrafts, the files in attachments.byThread). What the tab
// knows: the revision its content is based on and the content the server
// holds there (saved), whether the composer was edited since (edits against
// savedEdits — "dirty"), the read and the save in flight, the last save's
// failure, and a conflict — the other device's version, waiting for the
// user's word. The sync process (lib/drafts) watches edits and dirty and
// schedules the saves; the handlers (handlers.ts) do the requests.

import type { DraftView } from '../../../api/contract.ts';
import type { ApiFailure } from '../../lib/api/index.ts';
import type { Action } from '../types.ts';
import type { DraftContent } from './actions.ts';

export type DraftSync = {
  // The server revision the composer's content is based on; 0 — none seen.
  revision: number;
  // The content the server holds at `revision`, as last known; null —
  // never read.
  saved: DraftContent | null;
  // Local edits of the composer, counted; the sync process watches the
  // count, the handlers compare it with savedEdits.
  edits: number;
  // The edits count the server's content answers to: edits === savedEdits
  // — nothing unsaved.
  savedEdits: number;
  loading: boolean;
  loaded: boolean;
  // The save in flight, with the edits count it carries.
  saving: { edits: number } | null;
  failure: ApiFailure | null;
  // The other device's version a save ran into; the composer keeps this
  // tab's content meanwhile and asks.
  conflict: DraftView | null;
  // The edits count when the last send started: what was typed after it
  // is the next draft, still unsaved.
  sending: number | null;
};

export type DraftsState = {
  byThread: Record<string, DraftSync>;
  // Grows when the tab comes back into view or the stream reopens: a save
  // that failed gets another go (the sync process watches it).
  nudges: number;
};

export const initialDrafts: DraftsState = { byThread: {}, nudges: 0 };

export const emptyDraftSync: DraftSync = { revision: 0, saved: null, edits: 0, savedEdits: 0, loading: false, loaded: false, saving: null, failure: null, conflict: null, sending: null };

export const EMPTY_CONTENT: DraftContent = { text: '', fileIds: [] };

export function contentOf(draft: DraftView | null): DraftContent {
  return draft ? { text: draft.text, fileIds: draft.files.map(file => file.fileId) } : EMPTY_CONTENT;
}

export function sameContent(a: DraftContent, b: DraftContent): boolean {
  return a.text === b.text && a.fileIds.length === b.fileIds.length && a.fileIds.every((fileId, index) => b.fileIds[index] === fileId);
}

export function isEmptyContent(content: DraftContent): boolean {
  return content.text === '' && content.fileIds.length === 0;
}

export function isDirty(sync: DraftSync): boolean {
  return sync.edits !== sync.savedEdits;
}

// Whether the save in flight carries nothing typed after the last send
// started — its content is the sent message's, and the send settles it
// (sending still set, or _DONE already moved savedEdits past it).
export function saveSpentBySend(sync: DraftSync): boolean {
  return sync.saving !== null && sync.saving.edits <= (sync.sending ?? sync.savedEdits);
}

function patch(state: DraftsState, threadId: string, change: (sync: DraftSync) => DraftSync): DraftsState {
  const current = state.byThread[threadId] ?? emptyDraftSync;
  const next = change(current);

  return next === current && state.byThread[threadId] ? state : { ...state, byThread: { ...state.byThread, [threadId]: next } };
}

const edited = (sync: DraftSync): DraftSync => ({ ...sync, edits: sync.edits + 1 });

export function draftsReducer(state: DraftsState = initialDrafts, action: Action): DraftsState {
  switch (action.type) {
    // The composer's edits: the text, a file picked (its chip is the tab's
    // until uploaded — the save meanwhile carries the uploaded ones), an
    // upload done, a chip removed.
    case 'COMPOSER_DRAFT_SET':
    case 'ATTACHMENT_UPLOAD_DONE':
    case 'ATTACHMENT_REMOVE':
      return patch(state, action.threadId, edited);
    case 'ATTACH_FILES':
      return action.files.length ? patch(state, action.threadId, edited) : state;
    case 'DRAFT_LOAD':
      return patch(state, action.threadId, sync => (sync.loading ? sync : { ...sync, loading: true }));
    case 'DRAFT_LOAD_DONE':
      return patch(state, action.threadId, sync =>
        action.applied
          ? { ...sync, loading: false, loaded: true, revision: action.draft?.revision ?? 0, saved: contentOf(action.draft), savedEdits: sync.edits, failure: null }
          : { ...sync, loading: false, loaded: true },
      );
    case 'DRAFT_LOAD_FAIL':
      return patch(state, action.threadId, sync => ({ ...sync, loading: false }));
    case 'DRAFT_SAVE':
      return patch(state, action.threadId, sync => (sync.saving ? sync : { ...sync, saving: { edits: sync.edits } }));
    case 'DRAFT_SAVE_DONE':
      return patch(state, action.threadId, sync => ({
        ...sync,
        revision: action.revision,
        saved: action.content,
        savedEdits: sync.saving?.edits ?? sync.edits,
        saving: null,
        failure: null,
      }));
    case 'DRAFT_SAVE_CONFLICT':
      return patch(state, action.threadId, sync => ({ ...sync, saving: null, failure: null, conflict: action.server }));
    case 'DRAFT_SAVE_FAIL':
      return patch(state, action.threadId, sync => ({ ...sync, saving: null, failure: action.error }));
    case 'DRAFT_CONFLICT_USE_THEIRS':
      return patch(state, action.threadId, sync => ({ ...sync, revision: action.theirs.revision, saved: contentOf(action.theirs), savedEdits: sync.edits, conflict: null }));
    case 'DRAFT_CONFLICT_KEEP_MINE':
      // The server's version is what the server holds; this tab's content
      // stays unsaved over it, the next save lands on its revision.
      return patch(state, action.threadId, sync => (sync.conflict ? { ...sync, revision: sync.conflict.revision, saved: contentOf(sync.conflict), conflict: null } : sync));
    case 'SEND_MESSAGE':
      return patch(state, action.threadId, sync => ({ ...sync, sending: sync.edits }));
    case 'SEND_MESSAGE_DONE':
      // The server cleared the draft with the message (its revision moved
      // on unseen: a save of what was typed since lands on a stale base and
      // meets the empty server — the handler writes over it; a save of the
      // sent text itself, left before the send, meets it too — the handler
      // adopts the clear, saveSpentBySend). What was sent is saved by being
      // sent; what was typed meanwhile is unsaved.
      return patch(state, action.threadId, sync => ({ ...sync, saved: EMPTY_CONTENT, savedEdits: sync.sending ?? sync.edits, sending: null, conflict: null }));
    case 'SEND_MESSAGE_FAIL':
      return patch(state, action.threadId, sync => (sync.sending === null ? sync : { ...sync, sending: null }));
    case 'TAB_VISIBLE':
    case 'STREAM_OPENED':
      return { ...state, nudges: state.nudges + 1 };
    default:
      return state;
  }
}
