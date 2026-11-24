// Constants of the bundle, set when the extension is built
// (build/browser-extension.js) for the installation it belongs to.

// wss://<CONSOLE_DOMAIN> — where the links are dialed, no path.
declare const __SERVER_URL__: string;
// https://<CONSOLE_DOMAIN> — the only origin whose pages the extension answers.
declare const __CONSOLE_ORIGIN__: string;

// The stylesheets a page imports: esbuild bundles them into the page's CSS
// file; for tsc they are modules with no exports.
declare module '*.css';
