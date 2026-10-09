// The Api object for components that fetch the second data layer
// themselves (TanStack Query in features/file-area): the same instance the
// store's handlers receive, provided once in main.tsx.

import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';
import type { Api } from './index.ts';

const ApiContext = createContext<Api | null>(null);

export function ApiProvider({ api, children }: { api: Api; children: ReactNode }) {
  return <ApiContext.Provider value={api}>{children}</ApiContext.Provider>;
}

export function useApi(): Api {
  const api = useContext(ApiContext);

  if (!api) {
    throw new Error('useApi: no ApiProvider above');
  }

  return api;
}
