// The services of the installation — the second data layer (frontend.md,
// "Второй слой данных"): GET /api/installation-services answers the states
// of the external servers on the installation's credentials from the
// server's memory, not from the log. Read when the screen opens, then every
// half minute while it is visible and on the tab's return — credentials
// provisioned in the secrets form connect on the server's next look.

import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../lib/api/context.tsx';
import { retryUnlessClient } from '../../lib/api/retry.ts';

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
