// The feed's second data layer (frontend.md, "Второй слой данных"): the
// facts of a stored file by id — for an attachment the history names by
// fileId alone. A stored file is immutable, so the answer never goes stale;
// a 404 (not the session's file) is an answer, not something to retry.

import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../lib/api/context.tsx';
import { retryUnlessClient } from '../../lib/api/retry.ts';
import type { FileMetaResponse } from '../../../api/contract.ts';

const fileOf = (response: FileMetaResponse) => response.file;

export function useFileMeta(fileId: string | null, enabled: boolean) {
  const api = useApi();

  return useQuery({
    queryKey: ['file-meta', fileId],
    queryFn: ({ signal }) => api.files.meta(fileId as string, signal),
    select: fileOf,
    enabled: enabled && fileId !== null,
    retry: retryUnlessClient,
    staleTime: Infinity,
  });
}
