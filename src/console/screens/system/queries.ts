// System's second-layer data (frontend.md, "Второй слой данных"): the main
// thread's window of model requests — rows of llm_requests, which are not
// events of the log, so the card reads them when opened and on "Refresh".

import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../lib/api/context.tsx';
import { retryUnlessClient } from '../../lib/api/retry.ts';
import { TOKEN_WINDOW } from './SystemScreen.logic.ts';

export function useThreadRequests(threadId: string | null) {
  const api = useApi();

  return useQuery({
    queryKey: ['llm-requests', threadId, TOKEN_WINDOW],
    queryFn: ({ signal }) => api.llmRequests.list({ threadId: threadId ?? undefined, limit: TOKEN_WINDOW }, signal),
    enabled: threadId !== null,
    retry: retryUnlessClient,
  });
}
