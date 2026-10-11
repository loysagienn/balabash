// The system's second-layer data (frontend.md, "Второй слой данных"): the
// machine, the process and what runs in it as GET /api/system answers them
// — a measurement in the server's memory, not an event of the log. One
// query under SYSTEM_KEY (lib/query/system.ts invalidates it when a
// restart completes), two ways to read it: the System screen refreshes it
// every SYSTEM_REFRESH_MS while the tab is visible; the shell's footer, the
// summaries of Home and of a project's files take the facts as they are
// for a minute — a screen opened within it asks nothing.

import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../lib/api/context.tsx';
import { retryUnlessClient } from '../../lib/api/retry.ts';
import { SYSTEM_KEY } from '../../lib/query/system.ts';

export const SYSTEM_REFRESH_MS = 10_000;
export const SYSTEM_FACTS_FRESH_MS = 60_000;

export function useSystem() {
  const api = useApi();

  return useQuery({
    queryKey: SYSTEM_KEY,
    queryFn: ({ signal }) => api.system.get(signal),
    retry: retryUnlessClient,
    refetchInterval: SYSTEM_REFRESH_MS,
  });
}

export function useSystemFacts() {
  const api = useApi();

  return useQuery({
    queryKey: SYSTEM_KEY,
    queryFn: ({ signal }) => api.system.get(signal),
    retry: retryUnlessClient,
    staleTime: SYSTEM_FACTS_FRESH_MS,
  });
}
