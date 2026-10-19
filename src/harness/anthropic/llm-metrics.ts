// Telemetry for the Messages API requests (llm_requests table) — the twin
// of src/harness/openai/llm-metrics.ts over Anthropic's usage shape, which
// the columns do not share: the table's input_tokens is the whole prompt
// (the console's token chart stacks cached + cache write + uncached up to
// it, spec design/main-thread-token-chart.md), while Anthropic's
// `input_tokens` is only the tail after the last cache breakpoint —
// `cache_read_input_tokens` (the prefix served from the cache) and
// `cache_creation_input_tokens` (the prefix written) are separate addends:
// total input = cache_read + cache_creation + input_tokens. So the row is
// normalized here (usageToCounts); the usage as returned stays in
// raw_usage. Fire-and-forget like its twin: no failure here may ever
// affect the turn.

import type Anthropic from '@anthropic-ai/sdk';
import { asInt, recordLlmRequest } from '../llm-request-log.ts';
import type { LlmRequestContext } from '../turn-contract.ts';
import { getLlmBackend } from '../openai/backend.ts';

const PROVIDER = getLlmBackend().kind;

// The usage shape the SDK types may trail: the thinking count arrived in
// output_tokens_details, read defensively like the rest.
type UsageLike = {
  input_tokens?: unknown;
  cache_read_input_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
  output_tokens?: unknown;
  output_tokens_details?: { thinking_tokens?: unknown } | null;
};

export type UsageCounts = {
  inputTokens: number | null;
  cachedTokens: number | null;
  cacheWriteTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
};

function sum(values: Array<number | null>): number | null {
  const counted = values.filter((value): value is number => value !== null);

  return counted.length ? counted.reduce((total, value) => total + value, 0) : null;
}

/**
 * The token columns of a row from Anthropic's usage: inputTokens the whole
 * prompt (the uncached tail plus the cached and the written prefix — what
 * the chart stacks), cachedTokens and cacheWriteTokens the two prefix
 * parts, reasoningTokens the thinking share of the output, totalTokens
 * input + output. A missing field counts as absent, never as zero.
 */
export function usageToCounts(usage: UsageLike | null | undefined): UsageCounts {
  const tail = asInt(usage?.input_tokens);
  const cachedTokens = asInt(usage?.cache_read_input_tokens);
  const cacheWriteTokens = asInt(usage?.cache_creation_input_tokens);
  const outputTokens = asInt(usage?.output_tokens);
  const inputTokens = sum([tail, cachedTokens, cacheWriteTokens]);

  return {
    inputTokens,
    cachedTokens,
    cacheWriteTokens,
    outputTokens,
    reasoningTokens: asInt(usage?.output_tokens_details?.thinking_tokens),
    totalTokens: sum([inputTokens, outputTokens]),
  };
}

// The row's status: the stop reason, except that a prewarm ping always
// stops at its max_tokens: 0 — that is its completion, not a cut.
export function statusOf(message: Pick<Anthropic.Message, 'stop_reason'>, purpose: LlmRequestContext['purpose']): string {
  if (purpose === 'keepalive' && message.stop_reason === 'max_tokens') {
    return 'completed';
  }

  return message.stop_reason ?? 'completed';
}

/**
 * Per-turn measurement scope: counts inner-loop iterations and records one
 * llm_requests row per API call, including calls that threw.
 */
export function startLlmRequestMetrics({ workspaceId, threadId, lastSeq, requestedModel, purpose }: LlmRequestContext) {
  let iteration = 0;

  const measure = async (call: () => Promise<Anthropic.Message>): Promise<Anthropic.Message> => {
    iteration += 1;

    const currentIteration = iteration;
    const startedAt = Date.now();

    let message: Anthropic.Message;

    try {
      message = await call();
    } catch (error) {
      recordLlmRequest({
        workspaceId,
        threadId,
        provider: PROVIDER,
        model: requestedModel,
        lastSeq,
        iteration: currentIteration,
        purpose,
        status: 'request_failed',
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAt,
      });

      throw error;
    }

    const usage = message.usage;

    recordLlmRequest({
      workspaceId,
      threadId,
      provider: PROVIDER,
      model: message.model || requestedModel,
      responseId: message.id,
      lastSeq,
      iteration: currentIteration,
      purpose,
      status: statusOf(message, purpose),
      error: message.stop_reason === 'refusal' ? (message.stop_details?.explanation ?? 'refusal') : null,
      serviceTier: usage?.service_tier ?? null,
      durationMs: Date.now() - startedAt,
      ...usageToCounts(usage),
      rawUsage: { usage: usage ?? null } as unknown as Parameters<typeof recordLlmRequest>[0]['rawUsage'],
    });

    return message;
  };

  return { measure };
}
