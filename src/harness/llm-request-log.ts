// The llm_requests table writer shared by the drivers' metrics
// (src/harness/openai/llm-metrics.ts, src/harness/anthropic/llm-metrics.ts).
// Deliberately outside the event log and off the hot path: recording is
// fire-and-forget, and no failure here may ever affect the turn — errors go
// to stderr and nowhere else.

import type { Prisma } from '../../prisma-generated/client.ts';
import { prisma } from '../db/client.ts';

export function recordLlmRequest(data: Prisma.LlmRequestCreateInput): void {
  void prisma.llmRequest.create({ data }).catch(error => {
    console.error('llm-metrics: failed to record request', error);
  });
}

export function asInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
