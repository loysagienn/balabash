import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isMainThreadOpen, isMainThreadShortcut, keepsScrollPlace, mainThreadRoute, mainThreadShortcutLabel, restoreMove } from './shell.logic.ts';

const press = (key: string, mods: Partial<Omit<import('./shell.logic.ts').KeyPress, 'key'>> = {}) => ({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });

describe('main thread shortcut', () => {
  it('is ⌘J or Ctrl+J without other modifiers', () => {
    assert.equal(isMainThreadShortcut(press('j', { metaKey: true })), true);
    assert.equal(isMainThreadShortcut(press('J', { ctrlKey: true })), true);
    assert.equal(isMainThreadShortcut(press('j')), false);
    assert.equal(isMainThreadShortcut(press('j', { metaKey: true, shiftKey: true })), false);
    assert.equal(isMainThreadShortcut(press('j', { ctrlKey: true, altKey: true })), false);
    assert.equal(isMainThreadShortcut(press('k', { metaKey: true })), false);
  });

  it('is the same physical key under a non-Latin layout, not under another Latin one', () => {
    assert.equal(isMainThreadShortcut(press('о', { ctrlKey: true, code: 'KeyJ' })), true);
    assert.equal(isMainThreadShortcut(press('о', { metaKey: true, code: 'KeyJ' })), true);
    assert.equal(isMainThreadShortcut(press('о', { code: 'KeyJ' })), false);
    assert.equal(isMainThreadShortcut(press('о', { ctrlKey: true, code: 'KeyO' })), false);
    // Dvorak: the key at the J position gives "h" and says so.
    assert.equal(isMainThreadShortcut(press('h', { ctrlKey: true, code: 'KeyJ' })), false);
    assert.equal(isMainThreadShortcut(press('j', { ctrlKey: true, code: 'KeyC' })), true);
  });

  it('is not a press of an IME composition or one already handled', () => {
    assert.equal(isMainThreadShortcut(press('j', { ctrlKey: true, isComposing: true })), false);
    assert.equal(isMainThreadShortcut(press('j', { ctrlKey: true, defaultPrevented: true })), false);
    assert.equal(isMainThreadShortcut(press('j', { ctrlKey: true, isComposing: false, defaultPrevented: false })), true);
  });

  it('is labelled for the platform', () => {
    assert.equal(mainThreadShortcutLabel('MacIntel'), '⌘J');
    assert.equal(mainThreadShortcutLabel('iPhone'), '⌘J');
    assert.equal(mainThreadShortcutLabel('Linux x86_64'), 'Ctrl+J');
    assert.equal(mainThreadShortcutLabel('Win32'), 'Ctrl+J');
    assert.equal(mainThreadShortcutLabel(''), 'Ctrl+J');
  });
});

describe('main thread route', () => {
  it('exists once the session names the thread', () => {
    assert.equal(mainThreadRoute(null), null);
    assert.equal(mainThreadRoute(undefined), null);
    assert.deepEqual(mainThreadRoute('main'), { key: 'thread', id: 'main' });
  });

  it('is open only on the main thread page', () => {
    assert.equal(isMainThreadOpen({ key: 'thread', id: 'main' }, 'main'), true);
    assert.equal(isMainThreadOpen({ key: 'thread', id: 'other' }, 'main'), false);
    assert.equal(isMainThreadOpen({ key: 'threads' }, 'main'), false);
    assert.equal(isMainThreadOpen({ key: 'thread', id: 'main' }, null), false);
  });
});

describe('scroll place across routes', () => {
  it('is kept inside one project page, reset between pages', () => {
    assert.equal(keepsScrollPlace({ key: 'project', slug: 'p' }, { key: 'project', slug: 'p', path: 'docs' }), true);
    assert.equal(keepsScrollPlace({ key: 'project', slug: 'p', path: 'docs/a.md' }, { key: 'project', slug: 'p' }), true);
    assert.equal(keepsScrollPlace({ key: 'project', slug: 'p', path: 'a' }, { key: 'project', slug: 'p', path: 'b' }), true);
    assert.equal(keepsScrollPlace({ key: 'project', slug: 'p' }, { key: 'project', slug: 'q' }), false);
    assert.equal(keepsScrollPlace({ key: 'projects' }, { key: 'project', slug: 'p' }), false);
    assert.equal(keepsScrollPlace({ key: 'project', slug: 'p', path: 'a' }, { key: 'projects' }), false);
    assert.equal(keepsScrollPlace({ key: 'files', path: '' }, { key: 'files', path: 'a' }), false);
  });
});

describe('a place brought back by history', () => {
  it('is reached at once when the content is tall enough, as far as it goes while it is not', () => {
    assert.deepEqual(restoreMove({ target: 300, lastSet: null, scrollTop: 0, maxScroll: 1000 }), { to: 300, done: true });
    assert.deepEqual(restoreMove({ target: 300, lastSet: null, scrollTop: 0, maxScroll: 120 }), { to: 120, done: false });
    // The content grew: the box still where the last step put it — the next step.
    assert.deepEqual(restoreMove({ target: 300, lastSet: 120, scrollTop: 120, maxScroll: 260 }), { to: 260, done: false });
    assert.deepEqual(restoreMove({ target: 300, lastSet: 260, scrollTop: 260.5, maxScroll: 900 }), { to: 300, done: true });
    // A box with no room at all, and a place of zero: done either way.
    assert.deepEqual(restoreMove({ target: 300, lastSet: null, scrollTop: 0, maxScroll: 0 }), { to: 0, done: false });
    assert.deepEqual(restoreMove({ target: 0, lastSet: null, scrollTop: 0, maxScroll: 0 }), { to: 0, done: true });
  });

  it('is left to whoever moved the box since the last step', () => {
    // The reader scrolled, or the feed opened at its own place.
    assert.equal(restoreMove({ target: 300, lastSet: 120, scrollTop: 80, maxScroll: 900 }), null);
    assert.equal(restoreMove({ target: 300, lastSet: 120, scrollTop: 300, maxScroll: 900 }), null);
  });
});
