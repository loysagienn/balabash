// The limits' second-layer data (frontend.md, "Второй слой данных"): the
// plan's rate limits as GET /api/limits answers them — a measurement in the
// server's memory, not an event of the log. The card reads it when opened,
// then once a minute while the tab is visible (the server answers its cache
// unless a live Claude session can refresh it), and on the tab's return.

import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../lib/api/context.tsx';
import { retryUnlessClient } from '../../lib/api/retry.ts';

export const LIMITS_REFRESH_MS = 60_000;

export function useLimits() {
  const api = useApi();

  return useQuery({
    queryKey: ['limits'],
    queryFn: ({ signal }) => api.limits.get(signal),
    retry: retryUnlessClient,
    refetchInterval: LIMITS_REFRESH_MS,
  });
}
