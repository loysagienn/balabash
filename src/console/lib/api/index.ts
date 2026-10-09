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
};

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
  };
}
