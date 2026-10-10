// Entry of the console SPA. The shell (src/api/console.ts) mounts it into
// #root. Here the store is created with the route read from the location,
// the processes (history, event stream, tab visibility) are attached, React renders,
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

connectStoreToHistory(store);
connectStoreToStream(store);
connectStoreToVisibility(store);
// The phone's two-finger zoom is off (lib/touch/pinch.ts); desktop zoom — a
// touch screen beside a mouse included — is not.
installPinchGuard(document, navigator, window.matchMedia(PHONE_MEDIA));

// The operator's console is the operator's: the store is reachable from the
// browser console for debugging (window.__console.store.getState()).
window.__console = { store };

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 10_000 } } });

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
