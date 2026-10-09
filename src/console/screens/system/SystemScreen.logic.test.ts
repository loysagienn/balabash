import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { LlmRequestItem } from '../../../api/contract.ts';
import { TOKEN_WINDOW, toTokenRequest, windowCount, windowModels, windowRange } from './SystemScreen.logic.ts';

const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min);
const NOW = at(2026, 10, 9, 16, 38);

function row(partial: Partial<LlmRequestItem> = {}): LlmRequestItem {
  return {
    id: 'r1',
    createdAt: at(2026, 10, 9, 14, 41),
    threadId: 'main',
    provider: 'openai',
    model: 'gpt-5.2',
    responseId: null,
    previousResponseId: null,
    lastSeq: null,
    iteration: 1,
    purpose: 'turn',
    cacheDiagnostic: 'cache_hit',
    cacheMissReason: null,
    cacheMissedTokens: null,
    status: 'completed',
    error: null,
    serviceTier: null,
    durationMs: 6100,
    inputTokens: 40_000,
    cachedTokens: 30_000,
    cacheWriteTokens: 1_000,
    outputTokens: 500,
    reasoningTokens: 100,
    totalTokens: 40_500,
    ...partial,
  };
}

describe('system — the main thread card', () => {
  it('reads a row as a request of the chart', () => {
    assert.deepEqual(toTokenRequest(row()), {
      id: 'r1',
      at: at(2026, 10, 9, 14, 41),
      kind: 'turn',
      iteration: 1,
      input: 40_000,
      cached: 30_000,
      cacheWrite: 1_000,
      output: 500,
      reasoning: 100,
      durationMs: 6100,
      verdict: 'hit',
      missReason: null,
      error: null,
    });
    assert.equal(toTokenRequest(row({ purpose: 'keepalive' })).kind, 'keepalive');
    // Rows from before the purpose column are turns.
    assert.equal(toTokenRequest(row({ purpose: null })).kind, 'turn');
    assert.equal(toTokenRequest(row({ cacheDiagnostic: 'comparison_response_not_found' })).verdict, 'expired');
    assert.equal(toTokenRequest(row({ cacheDiagnostic: 'cache_miss', cacheMissReason: 'input_changed' })).missReason, 'input_changed');
    assert.equal(toTokenRequest(row({ cacheDiagnostic: 'unavailable' })).verdict, null);
    assert.equal(toTokenRequest(row({ cacheDiagnostic: null })).verdict, null);
  });

  it('reads a failed request without counts and with its error', () => {
    const failed = toTokenRequest(row({ status: 'request_failed', error: '502 Bad Gateway', inputTokens: null, cachedTokens: null, cacheWriteTokens: null, outputTokens: null, reasoningTokens: null, cacheDiagnostic: null }));

    assert.equal(failed.kind, 'failed');
    assert.equal(failed.error, '502 Bad Gateway');
    assert.deepEqual([failed.input, failed.cached, failed.cacheWrite, failed.output, failed.reasoning], [0, 0, 0, 0, 0]);
    // The error of a completed row is not a failure.
    assert.equal(toTokenRequest(row({ error: 'noted' })).error, null);
  });

  it('captions the window: its size, range and models', () => {
    assert.equal(windowCount(100, TOKEN_WINDOW), 'The last 100 model requests');
    assert.equal(windowCount(37, TOKEN_WINDOW), 'All 37 model requests');
    assert.equal(windowRange(at(2026, 10, 9, 5, 22), at(2026, 10, 9, 16, 31), NOW), 'today 05:22 – 16:31');
    assert.equal(windowRange(at(2026, 10, 8, 23, 10), at(2026, 10, 9, 0, 14), NOW), 'Oct 8, 23:10 – today 00:14');
    assert.equal(windowRange(at(2026, 10, 7, 23, 10), at(2026, 10, 8, 0, 14), NOW), 'Oct 7, 23:10 – Oct 8, 00:14');
    assert.equal(windowRange(at(2026, 10, 7, 9, 0), at(2026, 10, 7, 18, 0), NOW), 'Oct 7, 09:00 – 18:00');
    assert.equal(windowRange(at(2025, 10, 7, 9, 0), at(2026, 10, 9, 1, 0), NOW), 'Oct 7, 2025, 09:00 – today 01:00');
    assert.deepEqual(windowModels([row({ model: 'gpt-5.1' }), row({ model: 'gpt-5.2' }), row({ model: 'gpt-5.2' })]), ['gpt-5.2', 'gpt-5.1']);
  });
});
