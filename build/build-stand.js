import { buildServer } from './server.js';
import { buildConsole } from './console.js';

const NODE_ENV = process.env.NODE_ENV || 'development';

const APP_VERSION = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');

await buildServer(NODE_ENV, APP_VERSION, 3000);
await buildConsole(NODE_ENV, true);
