import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isMainThreadOpen, isMainThreadShortcut, mainThreadRoute, mainThreadShortcutLabel } from './shell.logic.ts';

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
