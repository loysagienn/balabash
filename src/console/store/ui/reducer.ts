// Interface state that is not data: the "More" menu on the phone, toasts,
// composer drafts per thread, whether a thread's message or command is on
// its way, the image viewer.
// Navigation closes the menu.

import type { Action } from '../types.ts';
import type { ThreadCommand } from '../threads/actions.ts';
import type { ToastInput, ViewerImage } from './actions.ts';

export type Toast = ToastInput & { id: number };

export type UiState = {
  moreMenu: boolean;
  // The "Sign in to another workspace" window is open.
  addWorkspace: boolean;
  toasts: Toast[];
  nextToastId: number;
  composerDrafts: Record<string, string>;
  // Threads whose composer message is on its way (SEND_MESSAGE), with the
  // draft as it was at the send: the field stays editable meanwhile, so a
  // success clears the draft only while it is still that one.
  composerSending: Record<string, { draft: string }>;
  // Thread commands on their way (COMMAND_THREAD): the button stays busy
  // until the server answered — the outcome itself comes with the tail.
  threadCommands: Record<string, Partial<Record<ThreadCommand, true>>>;
  // The image viewer, when open: the images and the one shown.
  viewer: { images: ViewerImage[]; index: number } | null;
};

export const initialUi: UiState = { moreMenu: false, addWorkspace: false, toasts: [], nextToastId: 1, composerDrafts: {}, composerSending: {}, threadCommands: {}, viewer: null };

function withCommand(state: UiState, threadId: string, command: ThreadCommand, pending: boolean): UiState['threadCommands'] {
  const { [command]: current, ...rest } = state.threadCommands[threadId] ?? {};

  if (pending) {
    return { ...state.threadCommands, [threadId]: { ...rest, [command]: true } };
  }

  if (!current) {
    return state.threadCommands;
  }

  const { [threadId]: dropped, ...others } = state.threadCommands;

  return Object.keys(rest).length ? { ...others, [threadId]: rest } : others;
}

function withoutSending(state: UiState, threadId: string): UiState['composerSending'] {
  const { [threadId]: dropped, ...rest } = state.composerSending;

  return dropped ? rest : state.composerSending;
}

export function uiReducer(state: UiState = initialUi, action: Action): UiState {
  switch (action.type) {
    case 'MORE_MENU_OPEN':
      return { ...state, moreMenu: true };
    case 'MORE_MENU_CLOSE':
      return state.moreMenu ? { ...state, moreMenu: false } : state;
    // Navigation closes the menu and the viewer.
    case 'ROUTE_TO':
      return state.moreMenu || state.viewer ? { ...state, moreMenu: false, viewer: null } : state;
    case 'VIEWER_OPEN':
      return action.images.length ? { ...state, viewer: { images: action.images, index: Math.max(0, Math.min(action.index, action.images.length - 1)) } } : state;
    case 'VIEWER_STEP': {
      const viewer = state.viewer;

      if (!viewer || viewer.images.length < 2) {
        return state;
      }

      const count = viewer.images.length;

      return { ...state, viewer: { ...viewer, index: (((viewer.index + action.by) % count) + count) % count } };
    }
    case 'VIEWER_CLOSE':
      return state.viewer ? { ...state, viewer: null } : state;
    case 'ADD_WORKSPACE_OPEN':
      return state.addWorkspace ? state : { ...state, addWorkspace: true };
    case 'ADD_WORKSPACE_CLOSE':
      return state.addWorkspace ? { ...state, addWorkspace: false } : state;
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
    case 'COMMAND_THREAD':
      return { ...state, threadCommands: withCommand(state, action.threadId, action.command, true) };
    case 'COMMAND_THREAD_DONE':
    case 'COMMAND_THREAD_FAIL':
      return { ...state, threadCommands: withCommand(state, action.threadId, action.command, false) };
    default:
      return state;
  }
}
