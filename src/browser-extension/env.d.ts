// Constants of the bundle, set when the extension is built
// (build/browser-extension.js) for the installation it belongs to.

// wss://<CONSOLE_DOMAIN> — where the links are dialed, no path.
declare const __SERVER_URL__: string;
// https://<CONSOLE_DOMAIN> — the only origin whose pages the extension answers.
declare const __CONSOLE_ORIGIN__: string;
