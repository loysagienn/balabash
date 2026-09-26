// Telemetry for LLM API requests (llm_requests table) — port of v1
// runner/llm-metrics plus the thread axis. Deliberately outside the event log
// and off the hot path: recording is fire-and-forget, and no failure here may
// ever affect the turn — errors go to stderr and nowhere else.

import type { Response } from 'openai/resources/responses/responses';
import type { Prisma } from '../../../prisma-generated/client.ts';
import { prisma } from '../../db/client.ts';

const PROVIDER = 'openai';

type LlmMetricsContext = {
  userId: string;
  threadId: string;
  lastSeq: bigint;
  requestedModel: string;
  // 'turn' — a model turn (1..N requests); 'keepalive' — a prompt-cache
  // prewarm ping (one request, no output).
  purpose: 'turn' | 'keepalive';
};

// The server's prompt-cache verdict against comparison_response_id, when the
// request asked for one. Typed by the SDK, but read defensively like the
// rest of the response extras.
type CacheDiagnostics = {
  cacheDiagnostic: string | null;
  cacheMissReason: string | null;
  cacheMissedTokens: number | null;
};

function readCacheDiagnostics(response: Response): CacheDiagnostics {
  const raw = (response as unknown as { prompt_cache_diagnostics?: unknown }).prompt_cache_diagnostics;

  if (!raw || typeof raw !== 'object') {
    return { cacheDiagnostic: null, cacheMissReason: null, cacheMissedTokens: null };
  }

  const diagnostics = raw as Record<string, unknown>;

  return {
    cacheDiagnostic: typeof diagnostics.type === 'string' ? diagnostics.type : null,
    cacheMissReason: typeof diagnostics.reason === 'string' ? diagnostics.reason : null,
    cacheMissedTokens: asInt(diagnostics.cache_missed_tokens),
  };
}

function asInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Per-turn measurement scope: counts inner-loop iterations and records one
 * llm_requests row per API call, including calls that threw.
 */
export function startLlmRequestMetrics({ userId, threadId, lastSeq, requestedModel, purpose }: LlmMetricsContext) {
  let iteration = 0;

  const record = (data: Prisma.LlmRequestCreateInput) => {
    void prisma.llmRequest.create({ data }).catch(error => {
      console.error('llm-metrics: failed to record request', error);
    });
  };

  const measure = async (call: () => Promise<Response>): Promise<Response> => {
    iteration += 1;

    const currentIteration = iteration;
    const startedAt = Date.now();

    let response: Response;

    try {
      response = await call();
    } catch (error) {
      record({
        userId,
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

    const usage = response.usage;
    // Newer usage fields (cache_write_tokens) and response fields (service_tier,
    // tool_usage) may be ahead of the SDK types; read them defensively.
    const inputDetails = (usage?.input_tokens_details ?? {}) as Record<string, unknown>;
    const outputDetails = (usage?.output_tokens_details ?? {}) as Record<string, unknown>;
    const extra = response as unknown as { service_tier?: unknown; tool_usage?: unknown; prompt_cache_diagnostics?: unknown };

    record({
      userId,
      threadId,
      provider: PROVIDER,
      model: response.model || requestedModel,
      responseId: response.id,
      previousResponseId: response.previous_response_id ?? null,
      lastSeq,
      iteration: currentIteration,
      purpose,
      status: response.status ?? 'completed',
      error: response.error ? response.error.message : null,
      serviceTier: typeof extra.service_tier === 'string' ? extra.service_tier : null,
      durationMs: Date.now() - startedAt,
      inputTokens: asInt(usage?.input_tokens),
      cachedTokens: asInt(inputDetails.cached_tokens),
      cacheWriteTokens: asInt(inputDetails.cache_write_tokens),
      outputTokens: asInt(usage?.output_tokens),
      reasoningTokens: asInt(outputDetails.reasoning_tokens),
      totalTokens: asInt(usage?.total_tokens),
      ...readCacheDiagnostics(response),
      rawUsage: {
        usage: usage ?? null,
        tool_usage: extra.tool_usage ?? null,
        prompt_cache_diagnostics: extra.prompt_cache_diagnostics ?? null,
      } as unknown as Prisma.InputJsonValue,
    });

    return response;
  };

  return { measure };
}
