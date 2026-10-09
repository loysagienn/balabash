// The file area's data: TanStack Query over the Api (frontend.md, "Второй
// слой данных") — a node (listing or file metadata) by path, a text file's
// content by path and modification time. A 404 is an answer (the path is
// gone), not something to retry.

import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../lib/api/context.tsx';
import { retryUnlessClient } from '../../lib/api/retry.ts';

export function useWorkspaceNode(path: string, enabled = true) {
  const api = useApi();

  return useQuery({
    queryKey: ['workspace', path],
    queryFn: () => api.workspace.node(path),
    enabled,
    retry: retryUnlessClient,
  });
}

// version — the file's modifiedAt: a new version is a new key, the old
// content is not shown for it.
export function useWorkspaceText(path: string, version: string | null, enabled: boolean) {
  const api = useApi();

  return useQuery({
    queryKey: ['workspace-text', path, version],
    queryFn: ({ signal }) => api.workspace.text(path, signal),
    enabled,
    retry: retryUnlessClient,
    staleTime: Infinity,
  });
}
