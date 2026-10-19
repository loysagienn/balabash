// The workspace of this tab. One browser is signed in to several workspaces
// (one session cookie, src/api/session.ts); each tab shows one of them, and
// every request of the tab names it: the X-Balabash-Workspace header on a
// fetch (lib/api), ?ws= on what the browser loads by itself — the event
// stream, file bytes (withWorkspace). A tab keeps its workspace in
// sessionStorage (its own, surviving a reload); the browser keeps the last
// workspace the user was in (localStorage) — what a new tab and a link from
// outside open — and the colors of the workspace marks (localStorage; the
// server knows nothing of them). Switching is a full load of Home in the
// chosen workspace: the store, the query cache and the stream start over,
// nothing of the previous workspace stays, no route of it is carried over.
//
// The workspace is fixed for the life of a page: set once at boot from the
// link (?ws=), the tab, or the last one, then confirmed by /api/me (a
// workspace no longer signed in answers the session's primary one).

import { WORKSPACE_QUERY, currentWorkspace, setCurrentWorkspace } from './state.ts';

export { WORKSPACE_HEADER, WORKSPACE_QUERY, currentWorkspace, withWorkspace } from './state.ts';

const TAB_KEY = 'balabash.workspace';
const LAST_KEY = 'balabash.lastWorkspace';
const COLORS_KEY = 'balabash.workspaceColors';
const FLASH_KEY = 'balabash.workspaceFlash';

export const WORKSPACE_COLORS = [1, 2, 3, 4, 5, 6, 7, 8] as const;

// What the next page says once it is up: signed in to one more workspace
// (with the way back), or signed out of the one the tab was showing.
export type WorkspaceFlash = { kind: 'signed-in'; back: { workspaceId: string; name: string } | null } | { kind: 'signed-out'; name: string };

// Storage that may refuse (a private window, a full quota, a disabled one):
// every read and write is best effort.
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function read(store: Store | null, key: string): string | null {
  try {
    return store?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(store: Store | null, key: string, value: string | null): void {
  try {
    if (value === null) {
      store?.removeItem(key);
    } else {
      store?.setItem(key, value);
    }
  } catch {
    // Nothing to do: the tab works, it just does not remember.
  }
}

function storage(kind: 'sessionStorage' | 'localStorage'): Store | null {
  try {
    return typeof window === 'undefined' ? null : window[kind];
  } catch {
    return null;
  }
}

// The page's workspace, as /api/me (or a sign-in) confirmed it: kept for
// this tab, and — while the tab is in front — as the browser's last one.
export function confirmWorkspace(workspaceId: string, { tab = storage('sessionStorage'), browser = storage('localStorage'), visible = isVisible() }: { tab?: Store | null; browser?: Store | null; visible?: boolean } = {}): void {
  setCurrentWorkspace(workspaceId);
  write(tab, TAB_KEY, workspaceId);

  if (visible) {
    write(browser, LAST_KEY, workspaceId);
  }
}

// The user came back to this tab: its workspace is the last one again.
export function rememberLastWorkspace(browser: Store | null = storage('localStorage')): void {
  const workspaceId = currentWorkspace();

  if (workspaceId) {
    write(browser, LAST_KEY, workspaceId);
  }
}

export function lastWorkspace(browser: Store | null = storage('localStorage')): string | null {
  return read(browser, LAST_KEY);
}

function isVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState === 'visible';
}

// Boot: the workspace a page starts in — the link's (?ws=, taken out of the
// address), the tab's, or the browser's last one; null — none known yet.
// Answers the address without ?ws= when the link carried one.
export function bootWorkspace(href: string, { tab = storage('sessionStorage'), browser = storage('localStorage') }: { tab?: Store | null; browser?: Store | null } = {}): { workspaceId: string | null; cleaned: string | null } {
  const url = new URL(href);
  const linked = url.searchParams.get(WORKSPACE_QUERY)?.trim() || null;
  let cleaned: string | null = null;

  if (url.searchParams.has(WORKSPACE_QUERY)) {
    url.searchParams.delete(WORKSPACE_QUERY);
    cleaned = url.pathname + url.search + url.hash;
  }

  const workspaceId = linked ?? read(tab, TAB_KEY) ?? read(browser, LAST_KEY);

  setCurrentWorkspace(workspaceId);

  if (linked) {
    write(tab, TAB_KEY, linked);
  }

  return { workspaceId, cleaned };
}

// The page that follows a switch: what to remember before leaving.
export function prepareSwitch(workspaceId: string, flash: WorkspaceFlash | null, { tab = storage('sessionStorage'), browser = storage('localStorage') }: { tab?: Store | null; browser?: Store | null } = {}): void {
  write(tab, TAB_KEY, workspaceId);
  write(browser, LAST_KEY, workspaceId);
  write(tab, FLASH_KEY, flash ? JSON.stringify(flash) : null);
}

// Signed out of the last workspace: the tab remembers none.
export function forgetWorkspace({ tab = storage('sessionStorage') }: { tab?: Store | null } = {}): void {
  setCurrentWorkspace(null);
  write(tab, TAB_KEY, null);
}

// Switching: Home of the chosen workspace, loaded anew.
export function switchWorkspace(workspaceId: string, flash: WorkspaceFlash | null = null): void {
  prepareSwitch(workspaceId, flash);
  window.location.assign('/');
}

// The tab's workspace is no longer signed in (signed out in another tab):
// load the page anew — /api/me answers the workspace the browser is in now.
export function leaveSignedOutWorkspace(): void {
  forgetWorkspace();
  window.location.assign('/');
}

// The flash the previous page left, taken once.
export function takeFlash(tab: Store | null = storage('sessionStorage')): WorkspaceFlash | null {
  const raw = read(tab, FLASH_KEY);

  if (raw === null) {
    return null;
  }

  write(tab, FLASH_KEY, null);

  try {
    const flash = JSON.parse(raw) as WorkspaceFlash;

    return flash && (flash.kind === 'signed-in' || flash.kind === 'signed-out') ? flash : null;
  } catch {
    return null;
  }
}

// Where to go after signing out of `from`: the last workspace the user was
// in, when it is still signed in, else the first one.
export function nextAfterSignOut(signedIn: string[], last: string | null): string | null {
  return last && signedIn.includes(last) ? last : (signedIn[0] ?? null);
}

// ---------------------------------------------------------------------------
// Mark colors: the browser's own choice per workspace (Settings → Workspace →
// Color). A workspace without one takes the first color no other workspace
// of this browser holds — and keeps it.

export type WorkspaceColors = Record<string, number>;

function isColor(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= WORKSPACE_COLORS.length;
}

export function readColors(browser: Store | null = storage('localStorage')): WorkspaceColors {
  const raw = read(browser, COLORS_KEY);

  if (!raw) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    const colors: WorkspaceColors = {};

    if (parsed && typeof parsed === 'object') {
      for (const [id, color] of Object.entries(parsed)) {
        if (isColor(color)) {
          colors[id] = color;
        }
      }
    }

    return colors;
  } catch {
    return {};
  }
}

// The colors of `ids`: the stored ones, and for the rest the first color
// not yet taken by another of `ids` (cycling once all eight are taken).
// Answers the colors and whether any was assigned (to be stored).
export function assignColors(ids: string[], stored: WorkspaceColors): { colors: WorkspaceColors; assigned: boolean } {
  const colors: WorkspaceColors = { ...stored };
  let assigned = false;

  for (const id of ids) {
    if (isColor(colors[id])) {
      continue;
    }

    const taken = new Set(ids.map(other => colors[other]).filter(isColor));
    const free = WORKSPACE_COLORS.find(color => !taken.has(color));

    colors[id] = free ?? WORKSPACE_COLORS[ids.indexOf(id) % WORKSPACE_COLORS.length]!;
    assigned = true;
  }

  return { colors, assigned };
}

export function workspaceColors(ids: string[], browser: Store | null = storage('localStorage')): WorkspaceColors {
  const { colors, assigned } = assignColors(ids, readColors(browser));

  if (assigned) {
    write(browser, COLORS_KEY, JSON.stringify(colors));
  }

  return colors;
}

export function setWorkspaceColor(workspaceId: string, color: number, browser: Store | null = storage('localStorage')): void {
  if (isColor(color)) {
    write(browser, COLORS_KEY, JSON.stringify({ ...readColors(browser), [workspaceId]: color }));
    announceColors();
  }
}

// A change of colors, for the marks on screen: this tab's own choice
// (setWorkspaceColor) and another tab's (the storage event).
const COLORS_EVENT = 'balabash:workspace-colors';

export function subscribeColors(listener: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === COLORS_KEY) {
      listener();
    }
  };

  window.addEventListener(COLORS_EVENT, listener);
  window.addEventListener('storage', onStorage);

  return () => {
    window.removeEventListener(COLORS_EVENT, listener);
    window.removeEventListener('storage', onStorage);
  };
}

export function colorsSnapshot(browser: Store | null = storage('localStorage')): string {
  return read(browser, COLORS_KEY) ?? '';
}

export function announceColors(): void {
  window.dispatchEvent(new Event(COLORS_EVENT));
}
