// The address of a new account derived from its name: lower-case latin,
// Cyrillic transliterated, the rest collapsed into dashes, a leading
// non-letter dropped; a taken address gets the next free suffix; a name with
// nothing usable becomes "account".
//
// Run: npm test  (node:test, native type stripping — no build needed).

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ACCOUNT_KEY_PATTERN, DEFAULT_ACCOUNT_KEY, deriveAccountKey } from './account-key.ts';

describe('deriveAccountKey', () => {
  test('derives a latin slug from the name', () => {
    assert.equal(deriveAccountKey('Personal mail', new Set()), 'personal-mail');
    assert.equal(deriveAccountKey("Vladimir's workspace", new Set()), 'vladimir-s-workspace');
    assert.equal(deriveAccountKey('Личный', new Set()), 'lichnyi');
    assert.equal(deriveAccountKey('2nd account', new Set()), 'nd-account');
  });

  test('suffixes a taken address and never answers the reserved default', () => {
    assert.equal(deriveAccountKey('Work', new Set(['work'])), 'work-2');
    assert.equal(deriveAccountKey('Work', new Set(['work', 'work-2'])), 'work-3');
    assert.equal(deriveAccountKey('Default', new Set([DEFAULT_ACCOUNT_KEY])), 'default-2');
  });

  test('a name with nothing usable becomes "account"', () => {
    assert.equal(deriveAccountKey('!!!', new Set()), 'account');
    assert.equal(deriveAccountKey('123', new Set(['account'])), 'account-2');
  });

  test('every answer is a valid address', () => {
    for (const name of ['Personal mail', 'Личный', '!!!', 'a'.repeat(80), '---x---']) {
      assert.match(deriveAccountKey(name, new Set()), ACCOUNT_KEY_PATTERN);
    }
  });
});
