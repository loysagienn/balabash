import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ctxVals, formatTokensK } from './Ring.logic.ts';

describe('ctxVals', () => {
  it('captions the percentage and spells the tokens in the tooltip', () => {
    assert.deepEqual(ctxVals({ percentage: 41, usedTokens: 82_000, maxTokens: 200_000 }), {
      percent: 41,
      text: '41%',
      hint: '82k of 200k',
      aria: 'Context 41%: 82k of 200k tokens',
    });
  });

  it('works without token counts', () => {
    assert.deepEqual(ctxVals({ percentage: 62.4 }), { percent: 62, text: '62%', hint: null, aria: 'Context 62%' });
  });

  it('rounds tokens to thousands', () => {
    assert.equal(formatTokensK(124_499), '124k');
    assert.equal(formatTokensK(500), '1k');
  });
});
