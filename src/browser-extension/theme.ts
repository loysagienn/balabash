// The color theme of the extension's pages. The console tells the extension
// the theme the user chose there (background.ts keeps it under THEME_KEY of
// chrome.storage.local); until it has, the system's scheme picks Graphite
// or Light. A page is drawn in the theme as the console is: data-bb-theme on
// <html>, Graphite being the absence of the attribute (the tokens of
// src/console/styles).
//
// chrome.storage answers late for the first paint, so a page keeps a copy of
// the last theme in its localStorage: theme-boot.ts — a script of the page's
// head — applies the copy before anything is drawn, and applyStoredTheme
// brings the page and the copy in line with the storage, now and whenever
// the console tells another theme.

import { DEFAULT_THEME, isThemeId } from '../utils/console-themes.ts';
import type { ThemeId } from '../utils/console-themes.ts';

export const THEME_KEY = 'theme';

export function systemTheme(): ThemeId {
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'graphite' : 'light';
}

function apply(stored: unknown): void {
  const theme = isThemeId(stored) ? stored : systemTheme();

  if (theme === DEFAULT_THEME) {
    document.documentElement.removeAttribute('data-bb-theme');
  } else {
    document.documentElement.setAttribute('data-bb-theme', theme);
  }

  try {
    if (isThemeId(stored)) {
      localStorage.setItem(THEME_KEY, stored);
    } else {
      localStorage.removeItem(THEME_KEY);
    }
  } catch {
    // The page is in the theme; it just starts in the system's one next time.
  }
}

export async function applyStoredTheme(): Promise<void> {
  apply((await chrome.storage.local.get(THEME_KEY))[THEME_KEY]);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[THEME_KEY]) {
      apply(changes[THEME_KEY].newValue);
    }
  });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    void chrome.storage.local.get(THEME_KEY).then(stored => apply(stored[THEME_KEY]));
  });
}
