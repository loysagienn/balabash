// The color themes of the console (design/themes.md): their ids, names and
// the two values the page needs before any stylesheet — the page color
// (theme-color of the browser chrome and the status bar of the installed
// app) and the color scheme of the native controls. The values of the
// tokens themselves live in src/console/styles/themes.css; the ids here
// are the `data-bb-theme` the theme blocks there answer to.
//
// Shared by the server shell (src/api/console.ts renders the boot script
// below into <head>) and the console (src/console/lib/theme), so the key
// and the ids agree on both sides.

export type ThemeId = 'graphite' | 'dusk' | 'light' | 'paper';

export type Theme = {
  id: ThemeId;
  name: string;
  // The one line under the name in the picker.
  desc: string;
  // tokens.css / themes.css --bg of the theme.
  bg: string;
  scheme: 'dark' | 'light';
};

export const THEMES: readonly Theme[] = [
  { id: 'graphite', name: 'Graphite', desc: 'Dark · neutral, high contrast', bg: '#0c0d0f', scheme: 'dark' },
  { id: 'dusk', name: 'Dusk', desc: 'Dark · warm gray, softer contrast', bg: '#1a1817', scheme: 'dark' },
  { id: 'light', name: 'Light', desc: 'Light · white, high contrast', bg: '#f3f4f6', scheme: 'light' },
  { id: 'paper', name: 'Paper', desc: 'Light · warm, softer contrast', bg: '#f2efe7', scheme: 'light' },
];

// Graphite: the values of tokens.css :root, no attribute on <html>.
export const DEFAULT_THEME: ThemeId = 'graphite';

// Where the browser keeps the choice (localStorage; one choice for every
// workspace of the browser, like the design says).
export const THEME_STORAGE_KEY = 'balabash.theme';

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && THEMES.some(theme => theme.id === value);
}

export function themeById(id: ThemeId): Theme {
  return THEMES.find(theme => theme.id === id) ?? THEMES[0]!;
}

// The boot script of the shell: runs inline in <head> before the
// stylesheet, so the first paint is already in the chosen theme (the
// console bundle itself is a deferred module and would repaint too late —
// a flash of Graphite on every load of a light theme). Reads the choice,
// sets data-bb-theme on <html> and the theme-color / color-scheme metas
// the head declares for Graphite. Storage that refuses leaves Graphite.
// The script is plain ES5 and carries no user data, so no escaping is
// needed beyond the JSON it is built from.
export function themeBootScript(): string {
  const table = Object.fromEntries(THEMES.filter(theme => theme.id !== DEFAULT_THEME).map(theme => [theme.id, [theme.bg, theme.scheme]]));

  return (
    `(function(){try{var T=${JSON.stringify(table)},t=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)}),v=T[t];if(!v)return;` +
    `var d=document;d.documentElement.setAttribute('data-bb-theme',t);` +
    `var m=d.querySelector('meta[name=theme-color]');if(m)m.setAttribute('content',v[0]);` +
    `var s=d.querySelector('meta[name=color-scheme]');if(s)s.setAttribute('content',v[1]);}catch(e){}})();`
  );
}
