// Pure rules of the shell's main-thread access (design: Shell "Main
// thread", ShellTop main button): which key press is the shortcut, how it
// is labelled, and whether the current route is the main thread itself.

import type { AppRoute } from '../../lib/router/routes.ts';

export type KeyPress = {
  key: string;
  // The physical key (KeyboardEvent.code); absent in a synthetic press.
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing?: boolean;
  defaultPrevented?: boolean;
};

// The key the press names, in the terms the hint uses: the letter the layout
// gives, or — when the layout gives no Latin letter (Cyrillic "о" on the
// same key) — the letter of the physical key. A Latin layout that puts
// another letter there (Dvorak) keeps its own letter: the hint says "J".
function latinKeyOf(press: KeyPress): string {
  if (/^[a-z]$/i.test(press.key)) {
    return press.key.toLowerCase();
  }

  const physical = press.code?.match(/^Key([A-Z])$/)?.[1];

  return physical ? physical.toLowerCase() : press.key.toLowerCase();
}

// ⌘J on a Mac keyboard, Ctrl+J elsewhere — one of the two, no other
// modifier, not inside an IME composition, not a press another handler
// already took.
export function isMainThreadShortcut(press: KeyPress): boolean {
  return (
    !press.isComposing && !press.defaultPrevented && (press.metaKey || press.ctrlKey) && !press.altKey && !press.shiftKey && latinKeyOf(press) === 'j'
  );
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
