// Pure rules of the shell's main-thread access (design: Shell "Main
// thread", ShellTop main button): which key press is the shortcut, how it
// is labelled, and whether the current route is the main thread itself.

import type { AppRoute } from '../../lib/router/routes.ts';

export type KeyPress = { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean };

// ⌘J on a Mac keyboard, Ctrl+J elsewhere — one of the two, no other modifier.
export function isMainThreadShortcut(press: KeyPress): boolean {
  return (press.metaKey || press.ctrlKey) && !press.altKey && !press.shiftKey && press.key.toLowerCase() === 'j';
}

// The label of the shortcut for the platform the page runs on.
export function mainThreadShortcutLabel(platform: string): string {
  return /mac|iphone|ipad|ipod/i.test(platform) ? '⌘J' : 'Ctrl+J';
}

// The main thread's route, or null until the session says which thread it is.
export function mainThreadRoute(mainThreadId: string | null | undefined): AppRoute | null {
  return mainThreadId ? { key: 'thread', id: mainThreadId } : null;
}

export function isMainThreadOpen(route: AppRoute, mainThreadId: string | null | undefined): boolean {
  return route.key === 'thread' && !!mainThreadId && route.id === mainThreadId;
}
