import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { COMPOSER_CONTROLS, composerKeyAction, focusesField, outgoingText } from './Composer.logic.ts';

const key = (overrides: Partial<Parameters<typeof composerKeyAction>[0]>) => ({
  key: 'Enter',
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...overrides,
});

describe('composerKeyAction', () => {
  it('sends on Enter alone', () => {
    assert.equal(composerKeyAction(key({}), false), 'send');
  });

  it('breaks the line on ⌘↵ and Ctrl+↵ by hand, leaves Shift+Enter to the textarea', () => {
    assert.equal(composerKeyAction(key({ metaKey: true }), false), 'newline');
    assert.equal(composerKeyAction(key({ ctrlKey: true }), false), 'newline');
    assert.equal(composerKeyAction(key({ shiftKey: true }), false), null);
    assert.equal(composerKeyAction(key({ metaKey: true, shiftKey: true }), false), null);
  });

  it('leaves composition, Alt and other keys alone', () => {
    assert.equal(composerKeyAction(key({ isComposing: true }), false), null);
    assert.equal(composerKeyAction(key({ keyCode: 229 }), false), null);
    assert.equal(composerKeyAction(key({ altKey: true }), false), null);
    assert.equal(composerKeyAction(key({ key: 'a' }), false), null);
    assert.equal(composerKeyAction(key({ key: 'a', metaKey: true }), false), null);
  });

  it('keeps Enter a new line on a phone', () => {
    assert.equal(composerKeyAction(key({}), true), null);
    assert.equal(composerKeyAction(key({ metaKey: true }), true), null);
  });
});

describe('outgoingText', () => {
  it('drops the surrounding blank lines and keeps the inner ones', () => {
    assert.equal(outgoingText('\n  \n\nhello\n\nworld \n\n'), 'hello\n\nworld');
    assert.equal(outgoingText('   \n'), '');
    assert.equal(outgoingText('   '), '');
    assert.equal(outgoingText(''), '');
  });

  it('keeps the indentation of the first line', () => {
    assert.equal(outgoingText('    const a = 1;\n    const b = 2;'), '    const a = 1;\n    const b = 2;');
    assert.equal(outgoingText('\n\t- item\n'), '\t- item');
  });
});

describe('focusesField', () => {
  // An element under the pointer, with the ancestors it would match.
  const at = (matches: string[]) => ({ closest: (selectors: string) => (matches.includes(selectors) ? {} : null) });

  it('the box itself, the row under the text and the hint focus the field', () => {
    assert.equal(focusesField(at([])), true);
  });

  it('the controls keep their taps: the buttons, the chips, the textarea', () => {
    assert.equal(focusesField(at([COMPOSER_CONTROLS])), false);
  });

  it('no target — nothing to focus', () => {
    assert.equal(focusesField(null), false);
  });
});
