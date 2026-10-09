import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { highlightParts } from './highlight.ts';

describe('highlightParts', () => {
  it('returns the whole text as plain without a match', () => {
    assert.deepEqual(highlightParts('Mini-apps: publishing by slug'), [{ text: 'Mini-apps: publishing by slug', hit: false }]);
    assert.deepEqual(highlightParts('Mini-apps', ''), [{ text: 'Mini-apps', hit: false }]);
    assert.deepEqual(highlightParts('', 'slug'), []);
  });

  it('splits around every match, keeping the original casing', () => {
    assert.deepEqual(highlightParts('Slug by slug', 'slug'), [
      { text: 'Slug', hit: true },
      { text: ' by ', hit: false },
      { text: 'slug', hit: true },
    ]);
  });

  it('keeps the tail after the last match and the head before the first', () => {
    assert.deepEqual(highlightParts('publishing by slug now', 'by'), [
      { text: 'publishing ', hit: false },
      { text: 'by', hit: true },
      { text: ' slug now', hit: false },
    ]);
  });

  it('leaves text without the match plain', () => {
    assert.deepEqual(highlightParts('Sort emails', 'slug'), [{ text: 'Sort emails', hit: false }]);
  });

  it('keeps the indices of the original text when lowercasing changes the length', () => {
    // "İ".toLowerCase() is two code units: "i" and a combining dot.
    assert.deepEqual(highlightParts('İstanbul slug', 'slug'), [
      { text: 'İstanbul ', hit: false },
      { text: 'slug', hit: true },
    ]);
    assert.deepEqual(highlightParts('İİx', 'x'), [
      { text: 'İİ', hit: false },
      { text: 'x', hit: true },
    ]);
    // A match that ends inside the expanded character takes the whole character.
    assert.deepEqual(highlightParts('İstanbul', 'i'), [
      { text: 'İ', hit: true },
      { text: 'stanbul', hit: false },
    ]);
    // Astral characters (surrogate pairs) are never cut in half.
    assert.deepEqual(highlightParts('🙂 Slug', 'slug'), [
      { text: '🙂 ', hit: false },
      { text: 'Slug', hit: true },
    ]);
    assert.deepEqual(highlightParts('a🙂b', '🙂'), [
      { text: 'a', hit: false },
      { text: '🙂', hit: true },
      { text: 'b', hit: false },
    ]);
  });
});
