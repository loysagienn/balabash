// Pure rules of the shell (design: Shell): the main-thread access ("Main
// thread" item, ShellTop main button — which key press is the shortcut,
// how it is labelled, whether the current route is the main thread
// itself), and how a place brought back by history is reached
// (restoreMove; which route changes keep the place — lib/router/nesting).

import type { AppRoute } from '../../lib/router/routes.ts';
import { countOf, durationLabel } from '../../lib/format/index.ts';
import { buildLabel } from '../system/version.ts';

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

// One step of bringing the body back to the place a history entry was
// left at (features/shell/scroll.ts runs it now and again as the screen
// grows): null — the box has moved since the last step (the reader, or
// the screen's own hand: the feed opening at its place), the place is
// theirs now; else where to scroll — the target, or as far as the content
// goes yet — and whether the target is reached (a later step is needed
// only while it is not). A place is "the same" within a pixel: a box
// reports fractions.
export type RestoreMove = { to: number; done: boolean } | null;

export function restoreMove(input: { target: number; lastSet: number | null; scrollTop: number; maxScroll: number }): RestoreMove {
  const { target, lastSet, scrollTop, maxScroll } = input;

  if (lastSet !== null && Math.abs(scrollTop - lastSet) > 1) {
    return null;
  }

  const to = Math.max(0, Math.min(target, maxScroll));

  return { to, done: to >= target };
}

// The sidebar's footer (design: .shell-foot — "3f9c21e · uptime 16h 17m /
// 4 agent sessions"): the build the process runs ("3f9c21e+" when the
// tree held uncommitted changes at the build) and its start from the facts
// read by place (GET /api/system), and the threads of this workspace at
// work from the store — named as what they are, active threads (the
// process's live sessions, every workspace's, are on System). Null without
// the facts: the footer is not drawn until the server answers (an older
// server has no /api/system).
export type FooterWords = { version: string | null; uptime: string; sessions: string };

export function footerWords(facts: { commit: string | null; dirty?: boolean; startedAt: Date } | null | undefined, running: number, now: Date): FooterWords | null {
  if (!facts) {
    return null;
  }

  return { version: buildLabel(facts), uptime: `uptime ${durationLabel(now.getTime() - facts.startedAt.getTime())}`, sessions: countOf(running, 'active thread') };
}
