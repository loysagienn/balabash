// Yandex Direct Reports dialect: POST /json/v5/reports, TSV in the answer.
// 200 = ready; 201/202 = the report is being built offline — the correct
// client behaviour is to repeat the SAME request until 200. The report name
// is derived deterministically from the request payload, so a later retry of
// the same tool call resumes the same queued report instead of spawning a
// new one.

import crypto from 'node:crypto';
import { DirectApiError } from './direct.ts';

const REPORTS_URL = 'https://api.direct.yandex.com/json/v5/reports';

// In-tool polling budget: enough for most sync/short offline builds, small
// against the platform's 10-minute tool timeout.
const POLL_TOTAL_MS = 75_000;
const POLL_DEFAULT_DELAY_MS = 10_000;

export type ReportRequest = {
  reportType: string;
  dateRangeType: string;
  dateFrom?: string | null;
  dateTo?: string | null;
  fieldNames: string[];
  filter?: unknown[] | null;
  goalIds?: string[] | null;
  includeVat: 'YES' | 'NO';
};

function buildParams(request: ReportRequest, reportName: string): Record<string, unknown> {
  const selectionCriteria: Record<string, unknown> = {};

  if (request.dateRangeType === 'CUSTOM_DATE') {
    selectionCriteria.DateFrom = request.dateFrom;
    selectionCriteria.DateTo = request.dateTo;
  }

  if (request.filter?.length) {
    selectionCriteria.Filter = request.filter;
  }

  return {
    SelectionCriteria: selectionCriteria,
    FieldNames: request.fieldNames,
    ...(request.goalIds?.length ? { Goals: request.goalIds } : {}),
    ReportName: reportName,
    ReportType: request.reportType,
    DateRangeType: request.dateRangeType,
    Format: 'TSV',
    IncludeVAT: request.includeVat,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function fetchReport(
  accessToken: string,
  request: ReportRequest,
): Promise<{ tsv: string; reportName: string }> {
  if (request.dateRangeType === 'CUSTOM_DATE' && (!request.dateFrom || !request.dateTo)) {
    throw new DirectApiError('date_range_type CUSTOM_DATE requires date_from and date_to (YYYY-MM-DD)', null);
  }

  // Deterministic name: the same tool arguments always address the same
  // report definition, which is what the offline queue requires on retry.
  const reportName = `balabash-${crypto
    .createHash('sha256')
    .update(JSON.stringify(request))
    .digest('hex')
    .slice(0, 24)}`;
  const body = JSON.stringify({ params: buildParams(request, reportName) });
  const deadline = Date.now() + POLL_TOTAL_MS;

  for (;;) {
    const response = await fetch(REPORTS_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'accept-language': 'ru',
        'content-type': 'application/json; charset=utf-8',
        processingMode: 'auto',
        returnMoneyInMicros: 'false',
        skipReportHeader: 'true',
        skipReportSummary: 'true',
      },
      body,
    });

    if (response.status === 200) {
      return { tsv: await response.text(), reportName };
    }

    if (response.status === 201 || response.status === 202) {
      await response.body?.cancel().catch(() => {});

      const retryInSeconds = Number(response.headers.get('retryin')) || POLL_DEFAULT_DELAY_MS / 1000;
      const delay = Math.min(retryInSeconds * 1000, POLL_DEFAULT_DELAY_MS);

      if (Date.now() + delay > deadline) {
        throw new DirectApiError(
          `The report is being built offline and is not ready yet (report "${reportName}"). Repeat the exact same call in a minute — it resumes this report instead of starting a new one.`,
          null,
        );
      }

      await sleep(delay);
      continue;
    }

    const text = await response.text();

    let detail = text.slice(0, 800);
    let code: number | null = null;

    try {
      const parsed = JSON.parse(text) as {
        error?: { error_code?: number | string; error_string?: string; error_detail?: string; request_id?: string };
      };

      if (parsed.error) {
        const parsedCode = Number(parsed.error.error_code);

        code = Number.isFinite(parsedCode) ? parsedCode : null;
        detail = [parsed.error.error_string, parsed.error.error_detail].filter(Boolean).join(' — ') || detail;
      }
    } catch {
      // keep raw text
    }

    throw new DirectApiError(
      `Reports API ${response.status}: ${detail}${code === 1002 || code === 1000 || code === 1001 ? ' Check field names and shapes via yandex_ads_describe("reports").' : ''}`,
      code,
    );
  }
}
