// The test PostgreSQL: a real server of the production's major version
// (embedded-postgres — the 16.x binaries against the managed 16.15, `SHOW
// server_version`), started once per `npm test` by the global setup
// (global-setup.ts) in a temporary directory and gone with it. The schema
// migrations are deployed into one template database, and every test that
// needs a database takes its own copy of the template — a fresh migrated
// schema in a few dozen milliseconds, nothing shared between files or
// cases, any number of copies at once (the files run in parallel). The test
// children learn of the server through the environment: node's global
// setup runs in the main process before the children are spawned, so what
// it puts in process.env reaches them.
//
// The database names end in `_test` and the host is the loopback — the
// shape db/test-guard.ts lets through to a Prisma client.

import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';

// The template's URL, as the global setup hands it to the test children.
export const TEST_PG_ENV = 'BALABASH_TEST_PG_URL';

const TEMPLATE = 'balabash_template_test';
const USER = 'balabash';
const PASSWORD = 'balabash';
const START_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 15_000;

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

export type TestPostgres = { url: string; stop(): Promise<void> };

// What startTestPostgres drives — embedded-postgres, or a stand-in in the
// tests of the lifecycle itself (pg.lifecycle.test.ts).
export type Cluster = Pick<EmbeddedPostgres, 'initialise' | 'start' | 'createDatabase' | 'stop'>;

// Start a cluster, deploy the migrations into the template. One per `npm
// test`, by the global setup only.
export async function startTestPostgres(): Promise<TestPostgres> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'balabash-test-pg-'));
  const port = await freePort();
  const log: string[] = [];
  const keep = (line: unknown) => {
    log.push(String(line).trim());
    if (log.length > 40) log.shift();
  };
  const cluster = new EmbeddedPostgres({
    databaseDir: path.join(dir, 'data'),
    port,
    user: USER,
    password: PASSWORD,
    persistent: false,
    onLog: keep,
    onError: keep,
  });
  const stop = async () => {
    await stopCluster(cluster, STOP_TIMEOUT_MS);
    await fs.rm(dir, { recursive: true, force: true });
  };

  try {
    await bootCluster(cluster, START_TIMEOUT_MS);
    const url = databaseUrl(port, TEMPLATE);
    await deployMigrations(url);
    const client = new pg.Client({ connectionString: databaseUrl(port, 'postgres') });
    await client.connect();
    await client.query(`alter database "${TEMPLATE}" is_template true`);
    await client.end();

    return { url, stop };
  } catch (error) {
    await stop();
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${log.join('\n')}`);
  }
}

// initdb, the server, the template — under one timeout. The timeout cancels
// the chain as well as giving up on it: a step that comes back after the
// deadline does not start the next one, so no server is spawned into a
// directory the caller is already removing. A server that exits before it
// is ready makes start() reject with nothing (embedded-postgres: a bare
// reject on `close`); that is named here, the server's own words are in the
// log the caller keeps.
export async function bootCluster(cluster: Cluster, timeoutMs: number): Promise<void> {
  let cancelled = false;
  const boot = (async () => {
    await cluster.initialise();
    if (cancelled) return;
    await cluster.start();
    if (cancelled) return;
    await cluster.createDatabase(TEMPLATE);
  })();

  try {
    await withTimeout(boot, timeoutMs, `the test PostgreSQL did not start in ${timeoutMs / 1000} s`);
  } catch (error) {
    cancelled = true;
    throw error ?? new Error('the test PostgreSQL exited before it was ready to accept connections');
  }
}

// embedded-postgres's stop() waits for the server's `exit` event — and waits
// forever when the server already exited before start() gave up on it (the
// listener is registered after the event). Bounded, and never a throw: what
// is gone is gone, the caller goes on to remove the directory either way.
export async function stopCluster(cluster: Cluster, timeoutMs: number): Promise<void> {
  await withTimeout(cluster.stop(), timeoutMs, 'the test PostgreSQL did not stop').catch(() => {});
}

export type TestDatabase = { name: string; url: string; drop(): Promise<void> };

// A fresh copy of the migrated template for one test or file. Drop it when
// done; the cluster dies with the run either way.
export async function createTestDatabase(): Promise<TestDatabase> {
  const template = testPostgresUrl();
  const name = `t_${crypto.randomBytes(6).toString('hex')}_test`;
  const url = new URL(template);
  url.pathname = `/${name}`;
  const maintenance = new URL(template);
  maintenance.pathname = '/postgres';

  const client = new pg.Client({ connectionString: maintenance.href });
  await client.connect();
  try {
    await client.query(`create database "${name}" template "${TEMPLATE}"`);
  } finally {
    await client.end();
  }

  return {
    name,
    url: url.href,
    drop: async () => {
      const client = new pg.Client({ connectionString: maintenance.href });
      await client.connect();
      try {
        await client.query(`drop database if exists "${name}" with (force)`);
      } finally {
        await client.end();
      }
    },
  };
}

export function testPostgresUrl(): string {
  const url = process.env[TEST_PG_ENV];

  if (!url) {
    throw new Error(
      `the test PostgreSQL is not running (${TEST_PG_ENV} is not set): run the tests through \`npm test\`, ` +
        'or add --test-global-setup=src/test-support/global-setup.ts to node --test',
    );
  }

  return url;
}

function databaseUrl(port: number, database: string): string {
  return `postgresql://${USER}:${PASSWORD}@127.0.0.1:${port}/${database}`;
}

// `prisma migrate deploy` against the template — the CLI from node_modules,
// the repository root as cwd (prisma.config.ts lives there; its dotenv
// never overrides a variable that is set, so this DATABASE_URL wins).
async function deployMigrations(url: string): Promise<void> {
  const cli = path.join(repoRoot, 'node_modules', 'prisma', 'build', 'index.js');

  try {
    await promisify(execFile)(process.execPath, [cli, 'migrate', 'deploy'], {
      cwd: repoRoot,
      env: { ...process.env, DATABASE_URL: url },
      timeout: START_TIMEOUT_MS,
    });
  } catch (error) {
    const { stdout = '', stderr = '' } = error as { stdout?: string; stderr?: string };
    throw new Error(`prisma migrate deploy failed on the test template:\n${stdout}${stderr}`);
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
