import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ctxVals, formatTokensK, ringDash, ringLevel } from './Ring.logic.ts';

describe('ringLevel', () => {
  it('follows rule 5: accent below 80, warn to 99, over from 100', () => {
    assert.equal(ringLevel(0), undefined);
    assert.equal(ringLevel(79.9), undefined);
    assert.equal(ringLevel(80), 'warn');
    assert.equal(ringLevel(99), 'warn');
    assert.equal(ringLevel(100), 'over');
    assert.equal(ringLevel(130), 'over');
  });
});

describe('ringDash', () => {
  it('clamps the drawn part to 0–100 of a 100-long path', () => {
    assert.equal(ringDash(62), '62 100');
    assert.equal(ringDash(130), '100 100');
    assert.equal(ringDash(-5), '0 100');
  });
});

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
