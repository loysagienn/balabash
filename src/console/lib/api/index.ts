// The Api object: one typed function per endpoint, grouped by domain.
// Action handlers receive it injected (store/middleware.ts), so a test
// replaces it with plain fake functions and never touches the network.

import type {
  AppsResponse,
  CreateProjectRequest,
  CreateProjectResponse,
  FileMetaResponse,
  LlmRequestsQuery,
  LlmRequestsResponse,
  LogoutResponse,
  MeResponse,
  ProjectResponse,
  ProvisionSecretsResponse,
  PublicationResponse,
  PublishAppRequest,
  SecretRequestResponse,
  SettingsPatchRequest,
  SettingsResponse,
  SnapshotResponse,
  ThreadEventsResponse,
  ThreadResponse,
  ThreadsQuery,
  ThreadsResponse,
  UnpublishAppRequest,
  UpdateProjectRequest,
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
  // POST /api/auth/console-code: the server prints a one-time code into its
  // log; 204 — nothing comes back; 429 when one was printed moments ago.
  consoleCode(): Promise<null>;
  logout(): Promise<LogoutResponse>;
  snapshot(): Promise<SnapshotResponse>;
  // The names of Settings: the answer carries the effective names as
  // /api/me reports them.
  settings: {
    update(patch: SettingsPatchRequest): Promise<SettingsResponse>;
  };
  // The project registry's changes (stage 6b): the answer carries the row
  // as the snapshot has it; the same change arrives as a project.* event
  // of the tail, folded idempotently.
  projects: {
    create(input: CreateProjectRequest): Promise<CreateProjectResponse>;
    update(id: string, patch: UpdateProjectRequest): Promise<ProjectResponse>;
    archive(id: string): Promise<ProjectResponse>;
    unarchive(id: string): Promise<ProjectResponse>;
  };
  // The apps listing as GET /api/apps reads it now — the snapshot's rows
  // read again (store/apps); the publication of an app folder and its end
  // (the answer names the slug and the path; the same change arrives as an
  // app.* event of the tail). A refusal is a 400 with the server's reason.
  apps: {
    list(): Promise<AppsResponse>;
    publish(input: PublishAppRequest): Promise<PublicationResponse>;
    unpublish(input: UnpublishAppRequest): Promise<PublicationResponse>;
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
  // A stored file's facts by id (the second data layer too): the name, type
  // and size of an attachment recorded by fileId alone. A 404 is the answer
  // "no such file of yours".
  files: {
    meta(fileId: string, signal?: AbortSignal): Promise<FileMetaResponse>;
  };
  // Model request telemetry (the second data layer too): the newest rows of
  // llm_requests, oldest first — one thread's window with threadId.
  llmRequests: {
    list(query: LlmRequestsQuery, signal?: AbortSignal): Promise<LlmRequestsResponse>;
  };
  // The trusted window of a one-time link (the second data layer too): the
  // field metadata of a secret request, and the values going to storage —
  // they never come back, not in the answer, not in an event. A 404 is the
  // answer "used or expired".
  secretRequests: {
    get(id: string, signal?: AbortSignal): Promise<SecretRequestResponse>;
    provision(id: string, values: Record<string, string>): Promise<ProvisionSecretsResponse>;
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
  const project = (id: string) => `/api/projects/${encodeURIComponent(id)}`;
  const secretRequest = (id: string) => `/api/secret-requests/${encodeURIComponent(id)}`;

  return {
    me: () => apiFetch<MeResponse>('/api/me', { unauthenticated: true }),
    auth: code => apiFetch<MeResponse>('/api/auth', { method: 'POST', body: { code }, unauthenticated: true }),
    consoleCode: () => apiFetch<null>('/api/auth/console-code', { method: 'POST', unauthenticated: true }),
    logout: () => apiFetch<LogoutResponse>('/api/logout', { method: 'POST', unauthenticated: true }),
    snapshot: () => apiFetch<SnapshotResponse>('/api/snapshot'),
    settings: {
      update: patch => apiFetch<SettingsResponse>('/api/settings', { method: 'PATCH', body: patch }),
    },
    projects: {
      create: input => apiFetch<CreateProjectResponse>('/api/projects', { method: 'POST', body: input }),
      update: (id, patch) => apiFetch<ProjectResponse>(project(id), { method: 'PATCH', body: patch }),
      archive: id => apiFetch<ProjectResponse>(`${project(id)}/archive`, { method: 'POST', body: {} }),
      unarchive: id => apiFetch<ProjectResponse>(`${project(id)}/unarchive`, { method: 'POST', body: {} }),
    },
    apps: {
      list: () => apiFetch<AppsResponse>('/api/apps'),
      publish: input => apiFetch<PublicationResponse>('/api/apps/publish', { method: 'POST', body: input }),
      unpublish: input => apiFetch<PublicationResponse>('/api/apps/unpublish', { method: 'POST', body: input }),
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
    files: {
      meta: (fileId, signal) => apiFetch<FileMetaResponse>(`/api/files/${encodeURIComponent(fileId)}/meta`, { signal }),
    },
    llmRequests: {
      list: (query, signal) => apiFetch<LlmRequestsResponse>('/api/llm-requests', { query, signal }),
    },
    secretRequests: {
      get: (id, signal) => apiFetch<SecretRequestResponse>(secretRequest(id), { signal }),
      provision: (id, values) => apiFetch<ProvisionSecretsResponse>(secretRequest(id), { method: 'POST', body: { values } }),
    },
  };
}
