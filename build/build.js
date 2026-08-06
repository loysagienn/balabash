import { buildServer } from './server.js';

const NODE_ENV = process.env.NODE_ENV || 'production';

const APP_VERSION = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');

buildServer(NODE_ENV, APP_VERSION);
