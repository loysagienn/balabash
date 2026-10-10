// Settings' second-layer data (frontend.md, "Второй слой данных"): the
// facts beside the names — the Telegram binding, the schedule's time zone,
// this browser's session (GET /api/settings). None is an event of the log:
// the screen reads them when opened and again on the tab's return (Query's
// refetch on focus) — a group bound meanwhile shows up on its own.

import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../lib/api/context.tsx';
import { retryUnlessClient } from '../../lib/api/retry.ts';

export function useSettingsFacts() {
  const api = useApi();

  return useQuery({
    queryKey: ['settings-facts'],
    queryFn: ({ signal }) => api.settings.get(signal),
    retry: retryUnlessClient,
  });
}
