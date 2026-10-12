// The Api object: one typed function per endpoint, grouped by domain.
// Action handlers receive it injected (store/middleware.ts), so a test
// replaces it with plain fake functions and never touches the network.

import type {
  AppsResponse,
  ConnectLinkResponse,
  ConnectionResponse,
  CreateProjectRequest,
  CreateProjectResponse,
  CreateTaskRequest,
  CreateTaskResponse,
  DeleteTaskResponse,
  FileMetaResponse,
  JobRunResponse,
  JobRunsQuery,
  JobRunsResponse,
  LatestJobRunsResponse,
  LimitsResponse,
  LlmRequestsQuery,
  LlmRequestsResponse,
  LogoutResponse,
  MeResponse,
  ProjectResponse,
  ProvisionSecretsResponse,
  PublicationResponse,
  PublishAppRequest,
  RenameConnectionRequest,
  RunTaskResponse,
  SecretRequestResponse,
  ForgetInstallationSecretsResponse,
  InstallationSecretRequestResponse,
  InstallationServicesResponse,
  SettingsFactsResponse,
  SettingsPatchRequest,
  SettingsResponse,
  SnapshotResponse,
  StartConnectionRequest,
  SystemResponse,
  TaskCommandRequest,
  ThreadEventsResponse,
  ThreadResponse,
  ThreadsQuery,
  ThreadsResponse,
  UnpublishAppRequest,
  UpdateProjectRequest,
  UploadFileResponse,
  WorkspaceNodeResponse,
  WorkspaceUploadResponse,
  WorkspaceWriteResponse,
  WorkspacesResponse,
} from '../../../api/contract.ts';
import { createFetch } from './fetch.ts';
import { createUpload } from './upload.ts';
import { withWorkspace } from '../workspace/state.ts';
import type { EtaggedText, FetchOptions } from './fetch.ts';

export type { ApiFailure, EtaggedText } from './fetch.ts';
export { ApiError, toApiFailure } from './fetch.ts';

export type ThreadEventsQuery = { before?: bigint; after?: bigint; limit?: number };

// An upload's progress (bytes sent) and its cancel.
export type TransferOptions = { onProgress?: (loaded: number) => void; signal?: AbortSignal };

export type Api = {
  me(): Promise<MeResponse>;
  auth(code: string): Promise<MeResponse>;
  // POST /api/auth/console-code: the server prints a one-time code into its
  // log; 204 — nothing comes back; 429 when one was printed moments ago.
  consoleCode(): Promise<null>;
  // Signs this browser out of the tab's workspace; the answer lists the
  // workspaces still signed in (an older server answers none).
  logout(): Promise<LogoutResponse>;
  // The workspaces this browser is signed in to (the switcher, Settings).
  workspaces: {
    list(signal?: AbortSignal): Promise<WorkspacesResponse>;
  };
  snapshot(): Promise<SnapshotResponse>;
  // The names of Settings: the answer carries the effective names as
  // /api/me reports them. The facts beside them (the Telegram binding, the
  // schedule's time zone, this browser's session) — the second data layer:
  // none is an event of the log.
  settings: {
    get(signal?: AbortSignal): Promise<SettingsFactsResponse>;
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
    // A message is text, files (stored fileIds) or both; a file that is not
    // accepted refuses the whole message (ApiError file_not_accepted with
    // the fileIds).
    sendMessage(id: string, text: string, fileIds?: string[]): Promise<unknown>;
    // The commands from above: a soft stop of the turn in flight, the end
    // of the thread. The outcome arrives through the event stream.
    interrupt(id: string): Promise<unknown>;
    cancel(id: string, reason?: string): Promise<unknown>;
  };
  // The file area (the second data layer — TanStack Query in
  // features/file-area, not the store): a node is a directory listing or
  // one file's metadata; text is the file's content from the root byte
  // surface /files/<rel> with the ETag of that read; write is the editor's
  // — the whole content of an existing Markdown file, etag naming the
  // content it replaces (If-Match; null — whatever is there): a 412 is
  // "changed since that read".
  workspace: {
    node(path: string): Promise<WorkspaceNodeResponse>;
    text(path: string, signal?: AbortSignal): Promise<EtaggedText>;
    write(path: string, text: string, etag: string | null): Promise<WorkspaceWriteResponse>;
    // A new file of the area from a picked file (POST /files/<rel>, XHR
    // with progress): conflict — the answer to a clash of names (none — a
    // taken name is a 409 `exists`); the answer's path is the name it got.
    upload(path: string, file: Blob, options: TransferOptions & { conflict?: 'replace' | 'keep' }): Promise<WorkspaceUploadResponse>;
  };
  // A stored file's facts by id (the second data layer too): the name, type
  // and size of an attachment recorded by fileId alone. A 404 is the answer
  // "no such file of yours".
  files: {
    meta(fileId: string, signal?: AbortSignal): Promise<FileMetaResponse>;
    // An attachment of the composer into storage (POST /api/files, XHR
    // with progress): the answer is the stored file, ready for a message.
    upload(file: Blob, name: string, options: TransferOptions): Promise<UploadFileResponse>;
  };
  // Model request telemetry (the second data layer too): the newest rows of
  // llm_requests, oldest first — one thread's window with threadId.
  llmRequests: {
    list(query: LlmRequestsQuery, signal?: AbortSignal): Promise<LlmRequestsResponse>;
  };
  // The plan's rate limits (the second data layer too): the newest
  // measurement a live Claude session took, with how many are alive to
  // refresh it.
  limits: {
    get(signal?: AbortSignal): Promise<LimitsResponse>;
  };
  // The machine, the process and what runs in it (the second data layer
  // too): a measurement of the moment — the System screen, the shell's
  // footer, the summaries of Home and a project's files.
  system: {
    get(signal?: AbortSignal): Promise<SystemResponse>;
  };
  // The schedule: the run journal of workspace jobs (the second data layer
  // — a page of runs newest first on a cursor, one run with its output,
  // the newest run of every task) and the operator's commands over the
  // tasks — a new task (the answer is the row as the snapshot has it and
  // whether a code task sleeps; the same row arrives as
  // schedule.task.created of the tail), a manual run (the schedule
  // untouched; the answer names the journal row of a command job) and a
  // delete (the answer is the row; the same end arrives as
  // schedule.task.cancelled of the tail). The run and the delete name the
  // row the operator saw (taskId): a slug held by another row since is a
  // 409 task_replaced, nothing done.
  schedule: {
    runs(query: JobRunsQuery, signal?: AbortSignal): Promise<JobRunsResponse>;
    latestRuns(signal?: AbortSignal): Promise<LatestJobRunsResponse>;
    run(id: string, signal?: AbortSignal): Promise<JobRunResponse>;
    createTask(input: CreateTaskRequest): Promise<CreateTaskResponse>;
    runTask(slug: string, taskId: string): Promise<RunTaskResponse>;
    deleteTask(slug: string, taskId: string): Promise<DeleteTaskResponse>;
  };
  // The operator's commands over the accounts of external services (the
  // Connections screen): a rename and a disconnect answer the row (the same
  // change arrives as connection.renamed / connection.disconnected of the
  // tail); a sign-in link for an existing account (reconnect) and for a
  // new one of a service of the catalog (connect) answer the link, the row
  // it belongs to and the link's expiry — the link is never in the log,
  // the flow's end arrives as connection.completed / connection.failed.
  connections: {
    rename(id: string, name: string): Promise<ConnectionResponse>;
    disconnect(id: string): Promise<ConnectionResponse>;
    reconnect(id: string): Promise<ConnectLinkResponse>;
    connect(input: StartConnectionRequest): Promise<ConnectLinkResponse>;
  };
  // The trusted window of a one-time link (the second data layer too): the
  // field metadata of a secret request, and the values going to storage —
  // they never come back, not in the answer, not in an event. A 404 is the
  // answer "used or expired".
  secretRequests: {
    get(id: string, signal?: AbortSignal): Promise<SecretRequestResponse>;
    provision(id: string, values: Record<string, string>): Promise<ProvisionSecretsResponse>;
  };
  // The services of the installation (the second data layer too): external
  // servers on the installation's credentials with their states; a request
  // for a service's credentials (the answer names the secrets form to open)
  // and forgetting them — for every workspace.
  installationServices: {
    list(signal?: AbortSignal): Promise<InstallationServicesResponse>;
    requestSecrets(name: string): Promise<InstallationSecretRequestResponse>;
    forgetSecrets(name: string): Promise<ForgetInstallationSecretsResponse>;
  };
};

// The path of a file's bytes on the byte surface: /files/<rel>, each
// segment encoded.
function fileBytesPath(path: string): string {
  const encoded = path
    .split('/')
    .filter(Boolean)
    .map(segment => encodeURIComponent(segment))
    .join('/');

  return `/files/${encoded}`;
}

// The URL of a file's bytes (/files/<rel>): inline for viewers, an
// attachment with download — in the tab's workspace (?ws=).
export function fileUrl(path: string, download = false): string {
  return withWorkspace(`${fileBytesPath(path)}${download ? '?download=1' : ''}`);
}

export function createApi(options: FetchOptions = {}): Api {
  const apiFetch = createFetch(options);
  const upload = createUpload(options);
  const thread = (id: string) => `/api/threads/${encodeURIComponent(id)}`;
  const project = (id: string) => `/api/projects/${encodeURIComponent(id)}`;
  const secretRequest = (id: string) => `/api/secret-requests/${encodeURIComponent(id)}`;
  const installationService = (name: string) => `/api/installation-services/${encodeURIComponent(name)}`;
  const task = (slug: string) => `/api/schedule/tasks/${encodeURIComponent(slug)}`;
  const connection = (id: string) => `/api/connections/${encodeURIComponent(id)}`;

  return {
    me: () => apiFetch<MeResponse>('/api/me', { unauthenticated: true }),
    auth: code => apiFetch<MeResponse>('/api/auth', { method: 'POST', body: { code }, unauthenticated: true }),
    consoleCode: () => apiFetch<null>('/api/auth/console-code', { method: 'POST', unauthenticated: true }),
    logout: () => apiFetch<LogoutResponse>('/api/logout', { method: 'POST', unauthenticated: true }),
    workspaces: {
      list: signal => apiFetch<WorkspacesResponse>('/api/workspaces', { signal }),
    },
    snapshot: () => apiFetch<SnapshotResponse>('/api/snapshot'),
    settings: {
      get: signal => apiFetch<SettingsFactsResponse>('/api/settings', { signal }),
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
      sendMessage: (id, text, fileIds) => apiFetch(`${thread(id)}/messages`, { method: 'POST', body: fileIds?.length ? { text, fileIds } : { text } }),
      interrupt: id => apiFetch(`${thread(id)}/interrupt`, { method: 'POST', body: {} }),
      cancel: (id, reason) => apiFetch(`${thread(id)}/cancel`, { method: 'POST', body: reason ? { reason } : {} }),
    },
    workspace: {
      node: path => apiFetch<WorkspaceNodeResponse>('/api/workspace/node', { query: { path } }),
      text: (path, signal) => apiFetch<EtaggedText>(fileUrl(path), { as: 'etagged', signal }),
      write: (path, text, etag) => apiFetch<WorkspaceWriteResponse>(fileUrl(path), { method: 'PUT', text, headers: etag === null ? undefined : { 'if-match': etag } }),
      upload: (path, file, { conflict, ...transfer }) =>
        upload<WorkspaceUploadResponse>({ url: `${fileBytesPath(path)}${conflict ? `?conflict=${conflict}` : ''}`, body: file, headers: { 'content-type': 'application/octet-stream' }, ...transfer }),
    },
    files: {
      meta: (fileId, signal) => apiFetch<FileMetaResponse>(`/api/files/${encodeURIComponent(fileId)}/meta`, { signal }),
      upload: (file, name, transfer) =>
        upload<UploadFileResponse>({ url: '/api/files', body: file, headers: { 'content-type': file.type || 'application/octet-stream', 'x-balabash-filename': encodeURIComponent(name) }, ...transfer }),
    },
    llmRequests: {
      list: (query, signal) => apiFetch<LlmRequestsResponse>('/api/llm-requests', { query, signal }),
    },
    limits: {
      get: signal => apiFetch<LimitsResponse>('/api/limits', { signal }),
    },
    system: {
      get: signal => apiFetch<SystemResponse>('/api/system', { signal }),
    },
    schedule: {
      runs: (query, signal) => apiFetch<JobRunsResponse>('/api/schedule/runs', { query, signal }),
      latestRuns: signal => apiFetch<LatestJobRunsResponse>('/api/schedule/runs/latest', { signal }),
      run: (id, signal) => apiFetch<JobRunResponse>(`/api/schedule/runs/${encodeURIComponent(id)}`, { signal }),
      createTask: input => apiFetch<CreateTaskResponse>('/api/schedule/tasks', { method: 'POST', body: input }),
      runTask: (slug, taskId) => apiFetch<RunTaskResponse>(`${task(slug)}/run`, { method: 'POST', body: { taskId } satisfies TaskCommandRequest }),
      deleteTask: (slug, taskId) => apiFetch<DeleteTaskResponse>(task(slug), { method: 'DELETE', query: { taskId } satisfies TaskCommandRequest }),
    },
    connections: {
      rename: (id, name) => apiFetch<ConnectionResponse>(connection(id), { method: 'PATCH', body: { name } satisfies RenameConnectionRequest }),
      disconnect: id => apiFetch<ConnectionResponse>(connection(id), { method: 'DELETE' }),
      reconnect: id => apiFetch<ConnectLinkResponse>(`${connection(id)}/reconnect`, { method: 'POST', body: {} }),
      connect: input => apiFetch<ConnectLinkResponse>('/api/connections', { method: 'POST', body: input }),
    },
    secretRequests: {
      get: (id, signal) => apiFetch<SecretRequestResponse>(secretRequest(id), { signal }),
      provision: (id, values) => apiFetch<ProvisionSecretsResponse>(secretRequest(id), { method: 'POST', body: { values } }),
    },
    installationServices: {
      list: signal => apiFetch<InstallationServicesResponse>('/api/installation-services', { signal }),
      requestSecrets: name => apiFetch<InstallationSecretRequestResponse>(`${installationService(name)}/secret-request`, { method: 'POST', body: {} }),
      forgetSecrets: name => apiFetch<ForgetInstallationSecretsResponse>(`${installationService(name)}/secrets`, { method: 'DELETE' }),
    },
  };
}
