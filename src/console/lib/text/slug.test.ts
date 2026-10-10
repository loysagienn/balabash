import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { capSlug, slugWords } from './slug.ts';

describe('slugWords', () => {
  it('makes dashed lowercase Latin words of a text', () => {
    assert.equal(slugWords('Bathroom renovation'), 'bathroom-renovation');
    assert.equal(slugWords('  Vacation 2027 — Japan!  '), 'vacation-2027-japan');
    assert.equal(slugWords('Ремонт ванной'), 'remont-vannoy');
    assert.equal(slugWords('Щи & борщ'), 'shchi-borshch');
    assert.equal(slugWords('Café Déjà vu'), 'cafe-deja-vu');
    assert.equal(slugWords('--- 2027 plans ---'), '2027-plans');
    assert.equal(slugWords('🙂'), '');
  });

  it('caps a slug without a dash at the end', () => {
    assert.equal(capSlug('abc-def', 4), 'abc');
    assert.equal(capSlug('abc-def', 3), 'abc');
    assert.equal(capSlug('abc', 10), 'abc');
  });
});
