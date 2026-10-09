// System's pure rules: the rows of GET /api/llm-requests as the token
// chart's requests, and the caption of the "Main thread · tokens per
// request" card (spec: design/main-thread-token-chart.md).

import type { LlmRequestItem } from '../../../api/contract.ts';
import { shortDate, timeOfDay } from '../../lib/format/index.ts';
import type { TokenRequest, TokenVerdict } from '../../ui/TokenChart/TokenChart.logic.ts';

// The window of the card: the main thread's last N requests.
export const TOKEN_WINDOW = 100;

const VERDICTS: Record<string, TokenVerdict> = {
  cache_hit: 'hit',
  comparison_response_not_found: 'expired',
  cache_miss: 'miss',
};

// A row of llm_requests as a request of the chart: purpose null (rows from
// before the column) reads as a turn; a failed request has no counts; the
// server's verdict 'unavailable' or none is not shown.
export function toTokenRequest(row: LlmRequestItem): TokenRequest {
  const failed = row.status === 'request_failed';

  return {
    id: row.id,
    at: row.createdAt,
    kind: failed ? 'failed' : row.purpose === 'keepalive' ? 'keepalive' : 'turn',
    iteration: row.iteration,
    input: row.inputTokens ?? 0,
    cached: row.cachedTokens ?? 0,
    cacheWrite: row.cacheWriteTokens ?? 0,
    output: row.outputTokens ?? 0,
    reasoning: row.reasoningTokens ?? 0,
    durationMs: row.durationMs,
    verdict: (row.cacheDiagnostic && VERDICTS[row.cacheDiagnostic]) || null,
    missReason: row.cacheMissReason,
    error: failed ? row.error : null,
  };
}

// "The last 100 model requests" when the window is full, "All 37 model
// requests" before that.
export function windowCount(n: number, window: number): string {
  return n >= window ? `The last ${window} model requests` : `All ${n} model requests`;
}

function dayOf(date: Date, now: Date): string {
  const same = date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();

  return same ? 'today' : shortDate(date, now);
}

// "today 05:22 – 16:31", "Oct 8, 23:10 – today 00:14", "Oct 7, 23:10 –
// Oct 8, 00:14" — the time range of the window.
export function windowRange(first: Date, last: Date, now: Date): string {
  const from = dayOf(first, now);
  const to = dayOf(last, now);
  const sep = (day: string) => (day === 'today' ? ' ' : ', ');

  return from === to ? `${from}${sep(from)}${timeOfDay(first)} – ${timeOfDay(last)}` : `${from}${sep(from)}${timeOfDay(first)} – ${to}${sep(to)}${timeOfDay(last)}`;
}

// The models of the window, newest first, each once.
export function windowModels(rows: LlmRequestItem[]): string[] {
  const models: string[] = [];

  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (!models.includes(rows[i].model)) {
      models.push(rows[i].model);
    }
  }

  return models;
}
