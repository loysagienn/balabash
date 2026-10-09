// The Api object: one typed function per endpoint, grouped by domain.
// Action handlers receive it injected (store/middleware.ts), so a test
// replaces it with plain fake functions and never touches the network.

import type {
  LogoutResponse,
  MeResponse,
  SettingsPatchRequest,
  SettingsResponse,
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
  // The names of Settings: the answer carries the effective names as
  // /api/me reports them.
  settings: {
    update(patch: SettingsPatchRequest): Promise<SettingsResponse>;
  };
  threads: {
    list(query: ThreadsQuery, signal?: AbortSignal): Promise<ThreadsResponse>;
    get(id: string): Promise<ThreadResponse>;
    events(id: string, query: ThreadEventsQuery): Promise<ThreadEventsResponse>;
    sendMessage(id: string, text: string): Promise<unknown>;
    // The commands from above: a soft stop of the turn in flight, the end
    // of the thread. The outcome arrives through the event stream.
    interrupt(id: string): Promise<unknown>;
    cancel(id: string, reason?: string): Promise<unknown>;
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
    settings: {
      update: patch => apiFetch<SettingsResponse>('/api/settings', { method: 'PATCH', body: patch }),
    },
    threads: {
      list: (query, signal) => apiFetch<ThreadsResponse>('/api/threads', { query, signal }),
      get: id => apiFetch<ThreadResponse>(thread(id)),
      events: (id, query) => apiFetch<ThreadEventsResponse>(`${thread(id)}/events`, { query }),
      sendMessage: (id, text) => apiFetch(`${thread(id)}/messages`, { method: 'POST', body: { text } }),
      interrupt: id => apiFetch(`${thread(id)}/interrupt`, { method: 'POST', body: {} }),
      cancel: (id, reason) => apiFetch(`${thread(id)}/cancel`, { method: 'POST', body: reason ? { reason } : {} }),
    },
    workspace: {
      node: path => apiFetch<WorkspaceNodeResponse>('/api/workspace/node', { query: { path } }),
      text: (path, signal) => apiFetch<string>(fileUrl(path), { as: 'text', signal }),
    },
  };
}
