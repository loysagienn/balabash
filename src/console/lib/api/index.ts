// The Api object: one typed function per endpoint, grouped by domain.
// Action handlers receive it injected (store/middleware.ts), so a test
// replaces it with plain fake functions and never touches the network.

import type {
  LogoutResponse,
  MeResponse,
  SnapshotResponse,
  ThreadEventsResponse,
  ThreadResponse,
  ThreadsQuery,
  ThreadsResponse,
  WorkspaceNodeResponse,
} from '../../../api/contract.ts';
import { createFetch } from './fetch.ts';
import type { FetchOptions } from './fetch.ts';

export type { ApiFailure } from './fetch.ts';
export { ApiError, toApiFailure } from './fetch.ts';

export type ThreadEventsQuery = { before?: bigint; after?: bigint; limit?: number };

export type Api = {
  me(): Promise<MeResponse>;
  auth(code: string): Promise<MeResponse>;
  logout(): Promise<LogoutResponse>;
  snapshot(): Promise<SnapshotResponse>;
  threads: {
    list(query: ThreadsQuery): Promise<ThreadsResponse>;
    get(id: string): Promise<ThreadResponse>;
    events(id: string, query: ThreadEventsQuery): Promise<ThreadEventsResponse>;
    sendMessage(id: string, text: string): Promise<unknown>;
  };
  // The file area (the second data layer — TanStack Query in
  // features/file-area, not the store): a node is a directory listing or
  // one file's metadata; text is the file's content from the root byte
  // surface /files/<rel>.
  workspace: {
    node(path: string): Promise<WorkspaceNodeResponse>;
    text(path: string, signal?: AbortSignal): Promise<string>;
  };
};

// The URL of a file's bytes (/files/<rel>): inline for viewers, an
// attachment with download.
export function fileUrl(path: string, download = false): string {
  const encoded = path
    .split('/')
    .filter(Boolean)
    .map(segment => encodeURIComponent(segment))
    .join('/');

  return `/files/${encoded}${download ? '?download=1' : ''}`;
}

export function createApi(options: FetchOptions = {}): Api {
  const apiFetch = createFetch(options);
  const thread = (id: string) => `/api/threads/${encodeURIComponent(id)}`;

  return {
    me: () => apiFetch<MeResponse>('/api/me', { unauthenticated: true }),
    auth: code => apiFetch<MeResponse>('/api/auth', { method: 'POST', body: { code }, unauthenticated: true }),
    logout: () => apiFetch<LogoutResponse>('/api/logout', { method: 'POST', unauthenticated: true }),
    snapshot: () => apiFetch<SnapshotResponse>('/api/snapshot'),
    threads: {
      list: query => apiFetch<ThreadsResponse>('/api/threads', { query }),
      get: id => apiFetch<ThreadResponse>(thread(id)),
      events: (id, query) => apiFetch<ThreadEventsResponse>(`${thread(id)}/events`, { query }),
      sendMessage: (id, text) => apiFetch(`${thread(id)}/messages`, { method: 'POST', body: { text } }),
    },
    workspace: {
      node: path => apiFetch<WorkspaceNodeResponse>('/api/workspace/node', { query: { path } }),
      text: (path, signal) => apiFetch<string>(fileUrl(path), { as: 'text', signal }),
    },
  };
}
