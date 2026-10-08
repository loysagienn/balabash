import { buildServer } from './server.js';
import { buildConsole } from './console.js';

const NODE_ENV = process.env.NODE_ENV || 'production';

const APP_VERSION = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');

// The console bundle rides the full build too (one `npm run build` produces
// everything); on its own it is `npm run build-console`.
await buildServer(NODE_ENV, APP_VERSION);
await buildConsole(NODE_ENV, NODE_ENV !== 'production');
