// The console's uploads: the bytes of one file as the whole request body,
// sent with XMLHttpRequest — the one browser door that reports the progress
// of a body on its way (fetch has none). Two of them: an attachment of the
// composer into storage (POST /api/files) and a new file of the file area
// (POST /files/<rel>). The answer and the refusals read as every API call
// reads them (ApiError, serialize-json); the connection lost is the
// "network" failure; a cancel (the signal) rejects with an AbortError and
// leaves nothing on the server — the request is cut off.

import { parseJson } from '../../../utils/serialize-json.ts';
import { ApiError } from './fetch.ts';
import type { FetchOptions } from './fetch.ts';
import { WORKSPACE_HEADER } from '../workspace/state.ts';

export type UploadRequest = {
  url: string;
  body: Blob;
  headers?: Record<string, string>;
  // Bytes sent so far (of body.size).
  onProgress?: (loaded: number) => void;
  signal?: AbortSignal;
};

// The part of XMLHttpRequest an upload uses, typed here: the core's
// typecheck reaches this module through the store (snapshot tests import
// the console's reducers) and has no DOM library.
type UploadXhr = {
  open(method: string, url: string): void;
  setRequestHeader(name: string, value: string): void;
  send(body: Blob): void;
  abort(): void;
  withCredentials: boolean;
  status: number;
  responseText: string;
  upload: { onprogress: ((event: { loaded: number }) => void) | null };
  onload: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
};

function createXhr(): UploadXhr {
  return new (globalThis as unknown as { XMLHttpRequest: new () => UploadXhr }).XMLHttpRequest();
}

export function abortError(): DOMException {
  return new DOMException('The upload was cancelled', 'AbortError');
}

export function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export function createUpload({ onUnauthorized, workspace }: FetchOptions = {}) {
  return function upload<T>({ url, body, headers, onProgress, signal }: UploadRequest): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError());

        return;
      }

      const xhr = createXhr();
      const userId = workspace?.() ?? null;
      const onAbort = () => xhr.abort();

      xhr.open('POST', url);
      xhr.withCredentials = true;

      for (const [name, value] of Object.entries({ ...headers, ...(userId ? { [WORKSPACE_HEADER]: userId } : {}) })) {
        xhr.setRequestHeader(name, value);
      }

      xhr.upload.onprogress = event => onProgress?.(event.loaded);
      xhr.onload = () => {
        signal?.removeEventListener('abort', onAbort);

        let data: unknown = null;

        try {
          data = xhr.responseText ? parseJson(xhr.responseText) : null;
        } catch {
          data = null;
        }

        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(data as T);

          return;
        }

        const error = (data as { error?: { code?: unknown; message?: unknown; fileIds?: unknown } } | null)?.error;
        const code = typeof error?.code === 'string' ? error.code : 'unknown';

        if (xhr.status === 401) {
          onUnauthorized?.(code);
        }

        // A refusal of the proxy in front (an HTML page, no JSON) still says
        // what it is by its status.
        reject(new ApiError(xhr.status, xhr.status === 413 && code === 'unknown' ? 'too_large' : code, typeof error?.message === 'string' ? error.message : `HTTP ${xhr.status}`));
      };
      xhr.onerror = () => {
        signal?.removeEventListener('abort', onAbort);
        reject(new ApiError(0, 'network', 'Connection lost'));
      };
      xhr.onabort = () => {
        signal?.removeEventListener('abort', onAbort);
        reject(abortError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      xhr.send(body);
    });
  };
}
