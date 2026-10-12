// The console's only door to the core: fetch against /api on the same host.
// Bodies cross the wire through serialize-json in both directions (bigint
// and Date survive); errors share the API's one shape ({error: {code,
// message}}) and surface as ApiError. A 401 on a session-gated call means
// the session is gone — the hook tells the store (SESSION_LOST); the auth
// endpoints themselves answer 401 as an ordinary outcome and opt out.

import { parseJson, stringifyJson } from '../../../utils/serialize-json.ts';
import type { ApiErrorBody } from '../../../api/contract.ts';
import { WORKSPACE_HEADER } from '../workspace/state.ts';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  // The files a message was refused for (file_not_accepted).
  readonly fileIds?: string[];

  constructor(status: number, code: string, message: string, fileIds?: string[]) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;

    if (fileIds) {
      this.fileIds = fileIds;
    }
  }
}

// The plain, serializable form an error takes inside the store.
export type ApiFailure = { status: number; code: string; message: string; fileIds?: string[] };

export function toApiFailure(error: unknown): ApiFailure {
  if (error instanceof ApiError) {
    return { status: error.status, code: error.code, message: error.message, ...(error.fileIds ? { fileIds: error.fileIds } : {}) };
  }

  return { status: 0, code: 'network', message: error instanceof Error ? error.message : String(error) };
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

export type FetchInit = {
  method?: string;
  body?: unknown;
  // A raw text body instead of JSON (the editor's write to /files/<rel>):
  // sent as text/plain in UTF-8.
  text?: string;
  // Headers beside the content type (a precondition, If-Match).
  headers?: Record<string, string>;
  query?: Record<string, string | number | bigint | boolean | undefined>;
  signal?: AbortSignal;
  // A 401 is an ordinary answer here (the auth endpoints), not a lost session.
  unauthenticated?: boolean;
  // The answer as text, not JSON — the raw byte surface of the file area
  // (/files/<rel>): a failure there still carries the API's JSON error.
  // 'etagged' — the text with the ETag of the answer, the validator a
  // later write of the same file names (EtaggedText).
  as?: 'text' | 'etagged';
};

export type EtaggedText = { text: string; etag: string | null };

export type FetchOptions = {
  // A session-gated call answered 401, with the refusal's code:
  // 'workspace_signed_out' — the tab's workspace is no longer signed in on
  // this browser (the session is); anything else — the session is gone.
  onUnauthorized?: (code: string) => void;
  // The workspace the tab acts in, named on every call (the header); null —
  // none known yet, the server answers the session's primary one.
  workspace?: () => string | null;
};

export function buildQuery(query: FetchInit['query']): string {
  if (!query) {
    return '';
  }

  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      params.set(key, String(value));
    }
  }

  const text = params.toString();

  return text ? `?${text}` : '';
}

export function createFetch({ onUnauthorized, workspace }: FetchOptions = {}) {
  return async function apiFetch<T>(path: string, init?: FetchInit): Promise<T> {
    const hasBody = init?.body !== undefined;
    const hasText = init?.text !== undefined;
    const userId = workspace?.() ?? null;
    const headers: Record<string, string> = {
      ...(hasBody ? { 'content-type': 'application/json' } : hasText ? { 'content-type': 'text/plain; charset=utf-8' } : {}),
      ...(userId ? { [WORKSPACE_HEADER]: userId } : {}),
      ...init?.headers,
    };

    const response = await fetch(path + buildQuery(init?.query), {
      method: init?.method ?? 'GET',
      headers: Object.keys(headers).length ? headers : undefined,
      body: hasBody ? stringifyJson(init.body) : init?.text,
      credentials: 'same-origin',
      signal: init?.signal,
    });

    const text = await response.text();
    let data: unknown = null;

    if (!response.ok || init?.as === undefined) {
      try {
        data = text ? parseJson(text) : null;
      } catch {
        data = null;
      }
    }

    if (!response.ok) {
      const error = extractError(data);

      if (response.status === 401 && !init?.unauthenticated) {
        onUnauthorized?.(error?.code ?? 'unknown');
      }

      throw new ApiError(response.status, error?.code ?? 'unknown', error?.message ?? `HTTP ${response.status}`, Array.isArray(error?.fileIds) ? error.fileIds : undefined);
    }

    if (init?.as === 'etagged') {
      const etagged: EtaggedText = { text, etag: response.headers.get('etag') };

      return etagged as T;
    }

    return (init?.as === 'text' ? text : data) as T;
  };
}
