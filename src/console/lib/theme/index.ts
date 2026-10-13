// The color theme of the console (design/themes.md): one of four, kept in
// this browser (localStorage, src/utils/console-themes.ts names the key and
// the ids) and applied as data-bb-theme on <html> — Graphite is the absence
// of the attribute. The shell's inline boot script applies the choice
// before the first paint; here the console keeps it applied for the life of
// the page: on choice in Settings, and on a choice made in another tab (the
// storage event). The browser chrome follows through the theme-color meta.

import { DEFAULT_THEME, THEME_STORAGE_KEY, isThemeId, themeById } from '../../../utils/console-themes.ts';
import type { ThemeId } from '../../../utils/console-themes.ts';

export { THEMES, DEFAULT_THEME, themeById } from '../../../utils/console-themes.ts';
export type { Theme, ThemeId } from '../../../utils/console-themes.ts';

// Storage that may refuse (a private window, a full quota): best effort.
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function storage(): Store | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readTheme(store: Store | null = storage()): ThemeId {
  try {
    const value = store?.getItem(THEME_STORAGE_KEY);

    return isThemeId(value) ? value : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

// Writes the choice; Graphite — the default — is written too, so a later
// change of the default does not move a browser that chose Graphite.
export function writeTheme(theme: ThemeId, store: Store | null = storage()): void {
  try {
    store?.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // The page is in the theme; the browser just does not remember it.
  }
}

// What a theme sets on the page: the attribute of <html> (null — none,
// Graphite) and the two metas.
export function pageTheme(theme: ThemeId): { attribute: string | null; themeColor: string; colorScheme: 'dark' | 'light' } {
  const { bg, scheme } = themeById(theme);

  return { attribute: theme === DEFAULT_THEME ? null : theme, themeColor: bg, colorScheme: scheme };
}

export function applyTheme(theme: ThemeId, doc: Document = document): void {
  const { attribute, themeColor, colorScheme } = pageTheme(theme);

  if (attribute === null) {
    doc.documentElement.removeAttribute('data-bb-theme');
  } else {
    doc.documentElement.setAttribute('data-bb-theme', attribute);
  }

  doc.querySelector('meta[name="theme-color"]')?.setAttribute('content', themeColor);
  doc.querySelector('meta[name="color-scheme"]')?.setAttribute('content', colorScheme);
}

// A change of the theme, for the picker on screen: this tab's own choice
// (setTheme) and another tab's (the storage event).
const THEME_EVENT = 'balabash:theme';

export function setTheme(theme: ThemeId): void {
  writeTheme(theme);
  applyTheme(theme);
  window.dispatchEvent(new Event(THEME_EVENT));
}

export function subscribeTheme(listener: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === THEME_STORAGE_KEY || event.key === null) {
      listener();
    }
  };

  window.addEventListener(THEME_EVENT, listener);
  window.addEventListener('storage', onStorage);

  return () => {
    window.removeEventListener(THEME_EVENT, listener);
    window.removeEventListener('storage', onStorage);
  };
}

export function themeSnapshot(): ThemeId {
  return readTheme();
}

// At boot: the page in the browser's theme (the shell's script did it
// before the first paint; an older shell did not), and kept there when
// another tab changes the choice.
export function connectDocumentToTheme(win: Window = window): () => void {
  applyTheme(readTheme(), win.document);

  const onStorage = (event: StorageEvent) => {
    if (event.key === THEME_STORAGE_KEY || event.key === null) {
      applyTheme(readTheme(), win.document);
    }
  };

  win.addEventListener('storage', onStorage);

  return () => win.removeEventListener('storage', onStorage);
}
