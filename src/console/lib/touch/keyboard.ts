// The on-screen keyboard and the system bar's inset. In a home-screen web app
// the phone's bottom inset (env(safe-area-inset-bottom) — 34 px on an
// iPhone, the place of the Home indicator) is added under the bottom bars:
// the composer, the file actions, a sheet, the tabs (styles/tokens.css,
// --safe-bottom). When the on-screen keyboard is out, the indicator sits over
// the keyboard, not under the bar — but iOS keeps the inset at its full
// value, and the inset becomes a dead strip between the field and the
// keyboard (Vladimir, 2026-10-16). This module marks the root —
// html[data-keyboard] — while a keyboard is out; the token is 0 under the
// mark, and the composer drops its own bottom padding too (Composer.css).
//
// What "a keyboard is out" is: a text field has the focus AND the visual
// viewport is lower than it is with no field focused, by at least a
// keyboard's height, at scale 1. The focus alone is not enough (a hardware
// keyboard shows nothing); the viewport alone is not enough either — a
// pinch zoom shrinks it as well (with a scale above 1), and the browser does
// not report its resize reliably. The focus is what lets the state in; what
// lets it out is the viewport alone, coming back to its free height: a tap
// on Send blurs the field first and lands its click after, and were the mark
// to go with the blur, the bar would grow under the finger and the click
// would miss the button (Vladimir, 2026-10-16). The browser's reports are
// not dependable: iOS fires the visual viewport's resize
// sometimes before the new height is in, sometimes not at all when the
// focus moves between fields. So the state is re-read on every signal there
// is — the visual viewport's resize and scroll, the window's resize, the
// focus moving in or out — and, after a focus change, again a few times
// while the keyboard's slide (≈ 0.3 s) runs its course. The reference
// height is the viewport's own, taken while no field is focused: on iOS
// window.innerHeight is not a dependable reference (it has followed the
// keyboard on some versions).
//
// The scroll is left to iOS: with the keyboard out it moves the page so the
// focused field — the caret, on every character typed — is in view. A hand
// of our own on the window's scroll fights that and the field jumps
// (tried, 2026-10-16); this module only reads the viewport, never moves it.

export type KeyboardState = { shown: boolean; focused: boolean; freeHeight: number; visualHeight: number; scale: number };

// Below this the difference is not a keyboard: a browser's bar collapsing,
// a rounding of the sizes, an accessory strip on its own. The smallest
// on-screen keyboard is far taller.
export const KEYBOARD_MIN_PX = 100;

export const KEYBOARD_ATTR = 'data-keyboard';

// After a focus change the state is re-read at these delays (ms): the
// keyboard slides in or out over about 0.3 s, and the viewport's events
// along the way are not dependable.
export const RECHECK_DELAYS_MS = [50, 150, 300, 500, 800];

// The rule: the visual viewport lower than the free one by a keyboard's height, at scale 1 — and, to enter the
// state, a text field focused; the state already on stays until the viewport comes back.
export function keyboardShown({ shown, focused, freeHeight, visualHeight, scale }: KeyboardState): boolean {
  return (shown || focused) && scale <= 1.01 && freeHeight - visualHeight >= KEYBOARD_MIN_PX;
}

export type FocusTarget = { tagName: string; type?: string; isContentEditable?: boolean } | null | undefined;

// Inputs that take no text: no keyboard comes out for them.
const NON_TEXT_INPUTS = new Set(['button', 'checkbox', 'radio', 'range', 'color', 'file', 'submit', 'reset', 'image', 'hidden']);

// A text entry: a textarea, an input that takes text, an editable element.
export function isTextEntry(target: FocusTarget): boolean {
  if (!target) {
    return false;
  }

  const tag = target.tagName.toUpperCase();

  if (tag === 'TEXTAREA') {
    return true;
  }

  if (tag === 'INPUT') {
    return !NON_TEXT_INPUTS.has((target.type ?? 'text').toLowerCase());
  }

  return target.isContentEditable === true;
}

export type ViewportSource = Pick<VisualViewport, 'height' | 'scale' | 'addEventListener' | 'removeEventListener'>;
export type KeyboardWindow = {
  visualViewport: ViewportSource | null;
  addEventListener: Window['addEventListener'];
  removeEventListener: Window['removeEventListener'];
};
export type KeyboardDocument = {
  documentElement: Pick<Element, 'setAttribute' | 'removeAttribute'>;
  activeElement: FocusTarget;
  addEventListener: Document['addEventListener'];
  removeEventListener: Document['removeEventListener'];
};
// Method signatures on purpose: the platform's own setTimeout/clearTimeout
// (overloaded, typed ids) fit them, and so do the tests' stand-ins.
export type Timers = { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(id: unknown): void };

/**
 * Keeps html[data-keyboard] (`doc` is the document) on while the on-screen
 * keyboard is out, by `win`'s visual viewport (window). Syncs at once and
 * on every signal; returns the teardown, which also clears the mark.
 * Without a visual viewport (an old browser) installs nothing — the inset
 * stays as the platform reports it.
 */
export function installKeyboardWatch(doc: KeyboardDocument, win: KeyboardWindow, timers: Timers = globalThis): () => void {
  const viewport = win.visualViewport;

  if (!viewport) {
    return () => {};
  }

  const root = doc.documentElement;
  let shown = false;
  let freeHeight = viewport.height;
  let pending: unknown[] = [];

  const sync = () => {
    const focused = isTextEntry(doc.activeElement);

    // The free height: the viewport's own while no field is focused and no
    // keyboard is out (a blurred field with the keyboard still sliding away is neither).
    if (!focused && !shown) {
      freeHeight = viewport.height;
    }

    const next = keyboardShown({ shown, focused, freeHeight, visualHeight: viewport.height, scale: viewport.scale });

    if (next === shown) {
      return;
    }

    shown = next;

    if (next) {
      root.setAttribute(KEYBOARD_ATTR, '');
    } else {
      root.removeAttribute(KEYBOARD_ATTR);
    }
  };

  // A focus change: sync now and again along the keyboard's slide.
  const onFocus = () => {
    for (const id of pending) {
      timers.clearTimeout(id);
    }

    sync();
    pending = RECHECK_DELAYS_MS.map(ms => timers.setTimeout(sync, ms));
  };

  sync();
  viewport.addEventListener('resize', sync);
  viewport.addEventListener('scroll', sync);
  win.addEventListener('resize', sync);
  doc.addEventListener('focusin', onFocus);
  doc.addEventListener('focusout', onFocus);

  return () => {
    viewport.removeEventListener('resize', sync);
    viewport.removeEventListener('scroll', sync);
    win.removeEventListener('resize', sync);
    doc.removeEventListener('focusin', onFocus);
    doc.removeEventListener('focusout', onFocus);

    for (const id of pending) {
      timers.clearTimeout(id);
    }

    pending = [];

    if (shown) {
      shown = false;
      root.removeAttribute(KEYBOARD_ATTR);
    }
  };
}
