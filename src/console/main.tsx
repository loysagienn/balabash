// Entry of the console SPA. The shell (src/api/console.ts) mounts it into
// #root. Here the store is created with the route read from the location,
// the processes (history, event stream, tab visibility, feed eviction) are attached, React renders,
// and the session check starts everything else (frontend.md, "Снимок +
// хвост").

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import './styles/index.css';
import { App } from './app/App.tsx';
import { ErrorBoundary } from './app/ErrorBoundary.tsx';
import { createApi } from './lib/api/index.ts';
import { ApiProvider } from './lib/api/context.tsx';
import { connectStoreToHistory } from './lib/router/history.ts';
import { readRoute } from './lib/router/routes.ts';
import { connectStoreToStream } from './lib/stream/index.ts';
import { connectStoreToVisibility } from './lib/visibility/index.ts';
import { connectStoreToFeedEviction } from './lib/feed-eviction/index.ts';
import { connectQueryClientToSession } from './lib/query/session.ts';
import { connectQueryClientToSecretRequests } from './lib/query/secret-requests.ts';
import { connectQueryClientToSchedule } from './lib/query/schedule.ts';
import { PHONE_MEDIA, installPinchGuard } from './lib/touch/pinch.ts';
import { createStore } from './store/index.ts';
import type { AppStore } from './store/index.ts';
import { sessionCheck, sessionLost } from './store/session/actions.ts';

const root = document.getElementById('root');

if (!root) {
  throw new Error('console: #root is missing from the shell');
}

let store: AppStore;

const api = createApi({ onUnauthorized: () => store.dispatch(sessionLost()) });

// bigint and Date live in the state; the DevTools serializer needs to know.
const devtools = window.__REDUX_DEVTOOLS_EXTENSION__?.({
  name: 'Balabash console',
  serialize: { replacer: (_key: string, value: unknown) => (typeof value === 'bigint' ? `${value}n` : value) },
});

store = createStore({ api, initialRoute: readRoute(window.location.pathname + window.location.search), initialHash: window.location.hash, enhancer: devtools });

// The body's scroll place an entry keeps when it is left (lib/router/history.ts).
connectStoreToHistory(store, { readScroll: () => document.querySelector<HTMLElement>('main.shell-body')?.scrollTop ?? null });
connectStoreToStream(store);
connectStoreToVisibility(store);
// The feeds of threads neither shown nor running leave the store after a
// while (lib/feed-eviction).
connectStoreToFeedEviction(store);
// The phone's two-finger zoom is off (lib/touch/pinch.ts); desktop zoom — a
// touch screen beside a mouse included — is not.
installPinchGuard(document, navigator, window.matchMedia(PHONE_MEDIA));

// The second data layer (frontend.md): data of the session, cleared when
// the session ends (lib/query/session.ts).
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 10_000 } } });

connectQueryClientToSession(store, queryClient);
// The form of a one-time link follows the request of its id in the store:
// issued again, the cached form is read again (lib/query/secret-requests.ts).
connectQueryClientToSecretRequests(store, queryClient);
connectQueryClientToSchedule(store, queryClient);

// The operator's console is the operator's: the store and the query client
// are reachable from the browser console for debugging
// (window.__console.store.getState(), window.__console.queryClient.getQueryCache()).
window.__console = { store, queryClient };

createRoot(root).render(
  <StrictMode>
    <Provider store={store}>
      <QueryClientProvider client={queryClient}>
        <ApiProvider api={api}>
          <ErrorBoundary>
            <App />
          </ErrorBoundary>
        </ApiProvider>
      </QueryClientProvider>
    </Provider>
  </StrictMode>,
);

store.dispatch(sessionCheck());
