import type { DraftView } from '../../../api/contract.ts';
import { draftFiles } from '../attachments/selectors.ts';
import type { State } from '../types.ts';
import type { DraftContent } from './actions.ts';
import { emptyDraftSync, isDirty } from './reducer.ts';
import type { DraftSync } from './reducer.ts';

export const selectDraftSync = (state: State, threadId: string): DraftSync => state.drafts.byThread[threadId] ?? emptyDraftSync;

// The other device's version waiting for the user's word, if any.
export const selectDraftConflict = (state: State, threadId: string): DraftView | null => state.drafts.byThread[threadId]?.conflict ?? null;

// The composer's content as the server would keep it: the text as typed
// and the stored files of the chips.
export function draftContentOf(state: State, threadId: string): DraftContent {
  return { text: state.ui.composerDrafts[threadId] ?? '', fileIds: draftFiles(state.attachments.byThread[threadId] ?? []).ready };
}

// Whether the tab has edits the server has not got.
export const selectDraftDirty = (state: State, threadId: string): boolean => isDirty(selectDraftSync(state, threadId));
