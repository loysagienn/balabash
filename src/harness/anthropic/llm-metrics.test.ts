import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { statusOf, usageToCounts } from './llm-metrics.ts';

describe('anthropic llm-metrics: usageToCounts', () => {
  it('sums the uncached tail with the cached and written prefix into the whole prompt', () => {
    // A live turn (2026-10-19): the tail after the breakpoint, the prefix
    // read, the delta written — the chart stacks the three up to input.
    const counts = usageToCounts({
      input_tokens: 5433,
      cache_read_input_tokens: 52_691,
      cache_creation_input_tokens: 266,
      output_tokens: 434,
      output_tokens_details: { thinking_tokens: 159 },
    });

    assert.deepEqual(counts, {
      inputTokens: 58_390,
      cachedTokens: 52_691,
      cacheWriteTokens: 266,
      outputTokens: 434,
      reasoningTokens: 159,
      totalTokens: 58_824,
    });
  });

  it('keeps the parts within the whole: cached + write ≤ input, reasoning ≤ output', () => {
    const counts = usageToCounts({ input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5, output_tokens: 7, output_tokens_details: { thinking_tokens: 3 } });

    assert.ok(counts.cachedTokens! + counts.cacheWriteTokens! <= counts.inputTokens!);
    assert.ok(counts.reasoningTokens! <= counts.outputTokens!);
  });

  it('reads a usage without cache fields as uncached and leaves absent counts null', () => {
    assert.deepEqual(usageToCounts({ input_tokens: 8, output_tokens: 2 }), {
      inputTokens: 8,
      cachedTokens: null,
      cacheWriteTokens: null,
      outputTokens: 2,
      reasoningTokens: null,
      totalTokens: 10,
    });
    assert.deepEqual(usageToCounts(undefined), {
      inputTokens: null,
      cachedTokens: null,
      cacheWriteTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      totalTokens: null,
    });
  });
});

describe('anthropic llm-metrics: statusOf', () => {
  it('is the stop reason of a turn, including a genuine max_tokens cut', () => {
    assert.equal(statusOf({ stop_reason: 'end_turn' }, 'turn'), 'end_turn');
    assert.equal(statusOf({ stop_reason: 'tool_use' }, 'turn'), 'tool_use');
    assert.equal(statusOf({ stop_reason: 'max_tokens' }, 'turn'), 'max_tokens');
    assert.equal(statusOf({ stop_reason: null }, 'turn'), 'completed');
  });

  it('reads a prewarm ping stopping at its max_tokens: 0 as completed', () => {
    assert.equal(statusOf({ stop_reason: 'max_tokens' }, 'keepalive'), 'completed');
    assert.equal(statusOf({ stop_reason: 'refusal' }, 'keepalive'), 'refusal');
  });
});
