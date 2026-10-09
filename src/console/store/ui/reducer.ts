// Interface state that is not data: the "More" sheet on the phone, toasts,
// composer drafts per thread. Navigation closes the sheet.

import type { Action } from '../types.ts';
import type { ToastInput } from './actions.ts';

export type Toast = ToastInput & { id: number };

export type UiState = {
  moreSheet: boolean;
  toasts: Toast[];
  nextToastId: number;
  composerDrafts: Record<string, string>;
};

export const initialUi: UiState = { moreSheet: false, toasts: [], nextToastId: 1, composerDrafts: {} };

export function uiReducer(state: UiState = initialUi, action: Action): UiState {
  switch (action.type) {
    case 'MORE_SHEET_OPEN':
      return { ...state, moreSheet: true };
    case 'MORE_SHEET_CLOSE':
    case 'ROUTE_TO':
      return state.moreSheet ? { ...state, moreSheet: false } : state;
    case 'TOAST_PUSH':
      return { ...state, toasts: [...state.toasts, { ...action.toast, id: state.nextToastId }], nextToastId: state.nextToastId + 1 };
    case 'TOAST_DISMISS':
      return { ...state, toasts: state.toasts.filter(toast => toast.id !== action.id) };
    case 'COMPOSER_DRAFT_SET':
      return { ...state, composerDrafts: { ...state.composerDrafts, [action.threadId]: action.text } };
    default:
      return state;
  }
}
