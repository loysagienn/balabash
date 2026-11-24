// Side-effect CSS imports of the console: esbuild bundles them into the
// entry's CSS file; for tsc they are modules with no exports. Plus the
// Redux DevTools extension hook, when the browser has it, and what Chrome
// gives a page that an installed extension lets talk to it
// (lib/extension).

declare module '*.css';

interface Window {
  __console?: { store: import('./store/index.ts').AppStore; queryClient: import('@tanstack/react-query').QueryClient };
  chrome?: { runtime?: { sendMessage?: (extensionId: string, message: unknown) => Promise<unknown> } };
  __REDUX_DEVTOOLS_EXTENSION__?: (options?: { name?: string; serialize?: { replacer?: (key: string, value: unknown) => unknown } }) => import('redux').StoreEnhancer;
}
