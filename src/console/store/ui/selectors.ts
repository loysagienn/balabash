import type { State } from '../types.ts';

export const selectMoreSheet = (state: State) => state.ui.moreSheet;
export const selectToasts = (state: State) => state.ui.toasts;
export const selectComposerDraft = (state: State, threadId: string) => state.ui.composerDrafts[threadId] ?? '';
export const selectComposerSending = (state: State, threadId: string) => state.ui.composerSending[threadId] !== undefined;
