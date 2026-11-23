import { buildServer } from './server.js';
import { buildConsole } from './console.js';
import { buildBrowserExtension } from './browser-extension.js';

const NODE_ENV = process.env.NODE_ENV || 'production';

const APP_VERSION = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');

// The console bundle and the browser extension ride the full build too (one
// `npm run build` produces everything); on their own they are
// `npm run build-console` and `npm run build-extension`.
await buildServer(NODE_ENV, APP_VERSION);
await buildConsole(NODE_ENV, NODE_ENV !== 'production');
await buildBrowserExtension();
