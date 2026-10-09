import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TOAST_TTL_MS, toastTtl } from './toasts.logic.ts';

describe('toastTtl', () => {
  it('keeps errors and requests for action until closed', () => {
    assert.equal(toastTtl('err'), null);
    assert.equal(toastTtl('act'), null);
  });

  it('lets results go on their own', () => {
    assert.equal(toastTtl('done'), TOAST_TTL_MS);
    assert.equal(toastTtl('run'), TOAST_TTL_MS);
    assert.equal(toastTtl(undefined), TOAST_TTL_MS);
  });
});
