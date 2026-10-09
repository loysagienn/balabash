import type { AppRoute } from '../../lib/router/routes.ts';

// action — a button on the toast that opens a route (and dismisses the toast).
export type ToastInput = { title: string; desc?: string; state?: 'run' | 'wait' | 'act' | 'done' | 'err' | 'off'; action?: { label: string; route: AppRoute } };

export const openMoreSheet = () => ({ type: 'MORE_SHEET_OPEN' }) as const;
export const closeMoreSheet = () => ({ type: 'MORE_SHEET_CLOSE' }) as const;
export const pushToast = (toast: ToastInput) => ({ type: 'TOAST_PUSH', toast }) as const;
export const dismissToast = (id: number) => ({ type: 'TOAST_DISMISS', id }) as const;
export const setComposerDraft = (threadId: string, text: string) => ({ type: 'COMPOSER_DRAFT_SET', threadId, text }) as const;
