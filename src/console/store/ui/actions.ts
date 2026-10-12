import type { AppRoute } from '../../lib/router/routes.ts';

// action — a button on the toast that opens a route, or switches the tab
// to another workspace (and dismisses the toast).
export type ToastAction = { label: string; route: AppRoute } | { label: string; workspace: string };
export type ToastInput = { title: string; desc?: string; state?: 'run' | 'wait' | 'act' | 'done' | 'err' | 'off'; action?: ToastAction };

export const openMoreSheet = () => ({ type: 'MORE_SHEET_OPEN' }) as const;
// "Sign in to another workspace": the code window (features/workspaces),
// opened from the switcher, Settings or the /login door of a signed-in tab.
export const openAddWorkspace = () => ({ type: 'ADD_WORKSPACE_OPEN' }) as const;
export const closeAddWorkspace = () => ({ type: 'ADD_WORKSPACE_CLOSE' }) as const;
export const closeMoreSheet = () => ({ type: 'MORE_SHEET_CLOSE' }) as const;
export const pushToast = (toast: ToastInput) => ({ type: 'TOAST_PUSH', toast }) as const;
export const dismissToast = (id: number) => ({ type: 'TOAST_DISMISS', id }) as const;
export const setComposerDraft = (threadId: string, text: string) => ({ type: 'COMPOSER_DRAFT_SET', threadId, text }) as const;

// The full-screen image viewer (design: Lightbox, rule 23) — one for every
// image of the console: the feed's and the summary's attachments, a draft
// chip's preview, an image of the file area. images — the images it steps
// through (those of one message; one alone elsewhere), index — the one
// shown.
export type ViewerImage = {
  src: string;
  name: string;
  // The details line: the size, who sent it where, when — what is known.
  meta: string[];
  // The bytes as a download; null — no download link (a draft's preview).
  download: string | null;
};

export const openViewer = (images: ViewerImage[], index: number) => ({ type: 'VIEWER_OPEN', images, index }) as const;
export const stepViewer = (by: number) => ({ type: 'VIEWER_STEP', by }) as const;
export const closeViewer = () => ({ type: 'VIEWER_CLOSE' }) as const;
