import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fieldIds } from './Field.logic.ts';

describe('fieldIds', () => {
  it('names the hint and the error by the field', () => {
    assert.deepEqual(fieldIds('np-title', { hint: false, err: false }), {});
    assert.deepEqual(fieldIds('np-slug', { hint: true, err: false }), { hintId: 'np-slug-h', describedBy: 'np-slug-h' });
    assert.deepEqual(fieldIds('np-slug', { hint: false, err: true }), { errId: 'np-slug-e', describedBy: 'np-slug-e' });
  });

  it('describes by the error first, then the hint', () => {
    assert.deepEqual(fieldIds('np-slug', { hint: true, err: true }), { hintId: 'np-slug-h', errId: 'np-slug-e', describedBy: 'np-slug-e np-slug-h' });
  });
});
