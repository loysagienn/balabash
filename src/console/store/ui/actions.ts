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
