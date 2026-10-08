// `npm run build-console` (production, one shot) and
// `npm run build-console-dev` (development, watch). Independent of the core
// build on purpose: the console goes live without a restart (build/console.js).

import { buildConsole } from './console.js';

const NODE_ENV = process.env.NODE_ENV || 'production';

buildConsole(NODE_ENV, NODE_ENV !== 'production');
