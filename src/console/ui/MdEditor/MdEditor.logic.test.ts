import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isSaveKey } from './MdEditor.logic.ts';

const key = (overrides: Partial<Parameters<typeof isSaveKey>[0]>) => ({
  key: 's',
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...overrides,
});

describe('isSaveKey', () => {
  it('saves on ⌘S and Ctrl+S, whatever the letter case', () => {
    assert.equal(isSaveKey(key({ metaKey: true })), true);
    assert.equal(isSaveKey(key({ ctrlKey: true })), true);
    assert.equal(isSaveKey(key({ key: 'S', ctrlKey: true })), true);
  });

  it('leaves a plain s, other modifiers and composition to the text', () => {
    assert.equal(isSaveKey(key({})), false);
    assert.equal(isSaveKey(key({ metaKey: true, shiftKey: true })), false);
    assert.equal(isSaveKey(key({ metaKey: true, altKey: true })), false);
    assert.equal(isSaveKey(key({ metaKey: true, isComposing: true })), false);
    assert.equal(isSaveKey(key({ key: 'a', metaKey: true })), false);
  });
});
