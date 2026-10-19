// The workspace this page acts in — the part of lib/workspace without the
// browser's globals: the API client (lib/api) and the projections that build
// file links read it, and they are typed by the server's project too.

export const WORKSPACE_HEADER = 'x-balabash-workspace'; // = src/api/session.ts
export const WORKSPACE_QUERY = 'ws';

let current: string | null = null;

// Set by lib/workspace (boot, confirmation, forgetting).
export function setCurrentWorkspace(workspaceId: string | null): void {
  current = workspaceId;
}

// The workspace this page acts in (null until known — the requests then
// name none, and the server answers the session's primary one).
export function currentWorkspace(): string | null {
  return current;
}

// A URL the browser loads by itself (the stream, file bytes), naming the
// page's workspace.
export function withWorkspace(url: string, workspaceId: string | null = current): string {
  if (!workspaceId) {
    return url;
  }

  const hash = url.indexOf('#');
  const base = hash === -1 ? url : url.slice(0, hash);
  const tail = hash === -1 ? '' : url.slice(hash);

  return `${base}${base.includes('?') ? '&' : '?'}${WORKSPACE_QUERY}=${encodeURIComponent(workspaceId)}${tail}`;
}
