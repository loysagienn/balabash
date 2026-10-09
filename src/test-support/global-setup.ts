// node:test global setup of `npm test` (package.json: --test-global-setup):
// runs once in the main process before the test files are spawned and once
// after they are done. It starts the test PostgreSQL (pg.ts) and hands its
// template URL to the children through the environment; it also takes the
// inherited DATABASE_URL away from them before they start — the live
// database is not for tests, whatever a test child imports (db/test-guard.ts
// is the lock inside the child; this is the one outside it).

import { BLOCKED_DATABASE_URL } from '../db/test-guard.ts';
import { TEST_PG_ENV, startTestPostgres } from './pg.ts';
import type { TestPostgres } from './pg.ts';

let server: TestPostgres | null = null;

export async function globalSetup(): Promise<void> {
  process.env.DATABASE_URL = BLOCKED_DATABASE_URL;
  server = await startTestPostgres();
  process.env[TEST_PG_ENV] = server.url;
}

export async function globalTeardown(): Promise<void> {
  await server?.stop();
  server = null;
}
