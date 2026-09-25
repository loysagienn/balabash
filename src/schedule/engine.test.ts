import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { clampJobTimeout, JOB_TIMEOUT_DEFAULT_MS, JOB_TIMEOUT_MAX_MS, JOB_TIMEOUT_MIN_MS } from './engine.ts';

describe('clampJobTimeout', () => {
  it('allows kill timeouts of up to 5 hours', () => {
    assert.equal(JOB_TIMEOUT_MAX_MS, 18_000_000);
    assert.equal(clampJobTimeout(3 * 60 * 60 * 1000), 10_800_000);
    assert.equal(clampJobTimeout(JOB_TIMEOUT_MAX_MS), JOB_TIMEOUT_MAX_MS);
    assert.equal(clampJobTimeout(JOB_TIMEOUT_MAX_MS + 1), JOB_TIMEOUT_MAX_MS);
  });

  it('falls back to the default and respects the lower bound', () => {
    assert.equal(clampJobTimeout(null), JOB_TIMEOUT_DEFAULT_MS);
    assert.equal(clampJobTimeout(0), JOB_TIMEOUT_MIN_MS);
  });
});
