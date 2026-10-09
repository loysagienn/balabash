import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isSendKey, outgoingText } from './Composer.logic.ts';

const key = (overrides: Partial<Parameters<typeof isSendKey>[0]>) => ({
  key: 'Enter',
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...overrides,
});

describe('isSendKey', () => {
  it('sends on ⌘↵ and Ctrl+↵', () => {
    assert.equal(isSendKey(key({ metaKey: true })), true);
    assert.equal(isSendKey(key({ ctrlKey: true })), true);
  });

  it('keeps Enter, Shift+Enter and composition for the text', () => {
    assert.equal(isSendKey(key({})), false);
    assert.equal(isSendKey(key({ shiftKey: true })), false);
    assert.equal(isSendKey(key({ metaKey: true, shiftKey: true })), false);
    assert.equal(isSendKey(key({ metaKey: true, isComposing: true })), false);
    assert.equal(isSendKey(key({ key: 'a', metaKey: true })), false);
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
