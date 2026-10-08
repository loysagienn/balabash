// The console's only door to the core: fetch against /api on the same host.
// Bodies cross the wire through serialize-json in both directions (bigint
// and Date survive); errors share the API's one shape ({error: {code,
// message}}) and surface as ApiError — a 401 means "no session".

import { parseJson, stringifyJson } from '../../utils/serialize-json.ts';
import type { ApiErrorBody } from '../../api/contract.ts';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

function extractError(data: unknown): ApiErrorBody['error'] | null {
  if (typeof data === 'object' && data !== null && 'error' in data) {
    const error = (data as ApiErrorBody).error;

    if (typeof error === 'object' && error !== null && typeof error.code === 'string') {
      return error;
    }
  }

  return null;
}

export async function apiFetch<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const hasBody = init?.body !== undefined;

  const response = await fetch(path, {
    method: init?.method ?? 'GET',
    headers: hasBody ? { 'content-type': 'application/json' } : undefined,
    body: hasBody ? stringifyJson(init.body) : undefined,
    credentials: 'same-origin',
  });

  const text = await response.text();
  let data: unknown = null;

  try {
    data = text ? parseJson(text) : null;
  } catch {
    data = null;
  }

  if (!response.ok) {
    const error = extractError(data);

    throw new ApiError(response.status, error?.code ?? 'unknown', error?.message ?? `HTTP ${response.status}`);
  }

  return data as T;
}
