// The services of the installation — the second data layer (frontend.md,
// "Второй слой данных"): GET /api/installation-services answers the states
// of the external servers on the installation's credentials from the
// server's memory, not from the log. Read when the screen opens, then every
// half minute while it is visible and on the tab's return — credentials
// provisioned in the secrets form connect on the server's next look.

import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../lib/api/context.tsx';
import { retryUnlessClient } from '../../lib/api/retry.ts';
import { BROWSERS_KEY } from '../../lib/query/browsers.ts';

export const INSTALLATION_SERVICES_KEY = ['installation-services'] as const;
export const INSTALLATION_SERVICES_REFRESH_MS = 30_000;

export function useInstallationServices() {
  const api = useApi();

  return useQuery({
    queryKey: INSTALLATION_SERVICES_KEY,
    queryFn: ({ signal }) => api.installationServices.list(signal),
    retry: retryUnlessClient,
    refetchInterval: INSTALLATION_SERVICES_REFRESH_MS,
  });
}

// The linked browsers — the second data layer too: GET /api/browsers
// answers the user's browsers and those of others enabled in the workspace,
// with who is connected now from the server's memory. Read when the screen
// opens and on the stream's `browsers` frame (lib/query/browsers.ts), and
// every half minute while it is visible — a frame can be lost with a broken
// stream.
export const BROWSERS_REFRESH_MS = 30_000;

export function useBrowsers() {
  const api = useApi();

  return useQuery({
    queryKey: BROWSERS_KEY,
    queryFn: ({ signal }) => api.browsers.list(signal),
    retry: retryUnlessClient,
    refetchInterval: BROWSERS_REFRESH_MS,
  });
}
