import type { State } from '../types.ts';

export const selectMoreSheet = (state: State) => state.ui.moreSheet;
export const selectToasts = (state: State) => state.ui.toasts;
