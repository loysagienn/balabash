// Interface state that is not data: the "More" sheet on the phone, toasts,
// composer drafts per thread and whether a thread's message is on its way.
// Navigation closes the sheet.

import type { Action } from '../types.ts';
import type { ToastInput } from './actions.ts';

export type Toast = ToastInput & { id: number };

export type UiState = {
  moreSheet: boolean;
  toasts: Toast[];
  nextToastId: number;
  composerDrafts: Record<string, string>;
  // Threads whose composer message is on its way (SEND_MESSAGE), with the
  // draft as it was at the send: the field stays editable meanwhile, so a
  // success clears the draft only while it is still that one.
  composerSending: Record<string, { draft: string }>;
};

export const initialUi: UiState = { moreSheet: false, toasts: [], nextToastId: 1, composerDrafts: {}, composerSending: {} };

function withoutSending(state: UiState, threadId: string): UiState['composerSending'] {
  const { [threadId]: dropped, ...rest } = state.composerSending;

  return dropped ? rest : state.composerSending;
}

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
    case 'SEND_MESSAGE':
      return { ...state, composerSending: { ...state.composerSending, [action.threadId]: { draft: state.composerDrafts[action.threadId] ?? '' } } };
    case 'SEND_MESSAGE_DONE': {
      const sent = state.composerSending[action.threadId];
      const { [action.threadId]: draft, ...composerDrafts } = state.composerDrafts;
      const unchanged = sent === undefined || draft === undefined || draft === sent.draft;

      return { ...state, composerDrafts: unchanged ? composerDrafts : state.composerDrafts, composerSending: withoutSending(state, action.threadId) };
    }
    case 'SEND_MESSAGE_FAIL':
      return { ...state, composerSending: withoutSending(state, action.threadId) };
    default:
      return state;
  }
}
