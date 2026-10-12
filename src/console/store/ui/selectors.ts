import type { State } from '../types.ts';
import type { ThreadCommand } from '../threads/actions.ts';

export const selectMoreSheet = (state: State) => state.ui.moreSheet;
export const selectAddWorkspace = (state: State) => state.ui.addWorkspace;
export const selectToasts = (state: State) => state.ui.toasts;
export const selectComposerDraft = (state: State, threadId: string) => state.ui.composerDrafts[threadId] ?? '';
export const selectComposerSending = (state: State, threadId: string) => state.ui.composerSending[threadId] !== undefined;
export const selectThreadCommandPending = (state: State, threadId: string, command: ThreadCommand) => state.ui.threadCommands[threadId]?.[command] === true;
export const selectViewer = (state: State) => state.ui.viewer;
