// The client's only door to the core: fetch against the /api namespace.
// Responses and request bodies cross the wire through serialize-json in both
// directions (bigint/Date survive). From the core tree the client imports
// contract types (TYPE-ONLY) and src/utils modules — utils are isolated by
// convention and safe to bundle anywhere.

import { parseJson, stringifyJson } from '../../utils/serialize-json';
import type { ApiErrorBody } from '../../api/contract';

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
