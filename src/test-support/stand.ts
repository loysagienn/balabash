// The stand of one test file: the app's own modules over a database of
// their own, in a file area of their own, reached over HTTP the way the
// console reaches them. startStand() takes a copy of the migrated template
// (pg.ts), moves the process into a temporary directory (the workspace
// layout resolves from cwd — src/workspace/layout.ts — so the file areas,
// the local file storage and every data/ path land there), sets the
// environment the app reads (DATABASE_URL of the copy, a session pepper,
// local file storage) and strips the channels and services inherited from
// the shell (Telegram, OpenAI, Spaces, the domains), then seeds the
// workspace the way a fresh install does — ensureOperatorWorkspace(): one
// user and its main thread — and signs in through the real code exchange
// (POST /api/auth), so the stand's cookie is a web session like any other.
// Requests go to a Koa listener on an ephemeral port carrying the /files
// and /api middleware exactly as src/api/index.ts mounts them (app.proxy,
// and the stand sends X-Forwarded-Proto: https — the session cookie is
// Secure).
//
// Import order — the one rule of using the stand. src/db/client.ts builds
// the Prisma client at import from DATABASE_URL as it is at that moment,
// and a static import is evaluated before the importing module's body,
// whatever `await` that body holds — so a test file imports the app's
// modules dynamically, after `await startStand()`:
//
//   let stand: Stand;
//   before(async () => { stand = await startStand(); });
//   after(() => stand.stop());
//   const { appendEvent } = await import('../core/append.ts');  // in a test or hook
//
// A static import of anything that reaches db/client.ts (core, api,
// projects, …) builds the client on the blocked address instead (the lock
// of db/test-guard.ts), and the stand's own check below fails with a hint
// before any test runs. One stand per file: the client is one per process,
// and node:test runs each file in a process of its own.
//
// stop() releases what the stand acquired whatever state a test left it in:
// the listener's connections are cut (an event stream left open is no
// hold), and every step runs even when another failed.

import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import Koa from 'koa';
import { parseJson } from '../utils/serialize-json.ts';
import { TEMPLATE_DATABASE, createTestDatabase } from './pg.ts';
import type { TestDatabase } from './pg.ts';

export const STAND_HOST = 'console.test';
export const SESSION_PEPPER = 'test-pepper';

// What the app reads from the environment besides DATABASE_URL
// (src/config/index.ts) — taken away so a test never depends on, or
// reaches, what the shell inherited from the live app.
const INHERITED_ENV = [
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_ALLOWED_LOGINS',
  'CCR_ENABLED',
  'OPERATOR_USER_ID',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'LLM_BACKEND',
  'MAIN_OPENAI_MODEL',
  'INDEXER_OPENAI_MODEL',
  'DOMAIN',
  'HTTP_PORT',
  'APPS_DOMAIN',
  'CONSOLE_DOMAIN',
  'APPS_COOKIE_SECRET',
  'SCHEDULE_TIMEZONE',
  'FILES_ROOT',
  'SPACES_REGION',
  'SPACES_BUCKET_NAME',
  'SPACES_ACCESS_KEY_ID',
  'SPACES_ACCESS_KEY_SECRET',
];

export type Reply = {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  // The body through serialize-json (Dates and bigints restored), as the
  // console reads it.
  json<T = unknown>(): T;
};

export type RequestOptions = {
  // A JSON body (serialized as is — the tests of the body rule send text).
  body?: unknown;
  // Raw body text, sent as application/json.
  text?: string;
  // The Cookie header; the stand's session by default, null for none.
  cookie?: string | null;
  headers?: Record<string, string>;
  // Aborting it rejects the request with the signal's reason (an
  // AbortError) — the way to leave an open stream.
  signal?: AbortSignal;
};

export type Stand = {
  db: TestDatabase;
  // The temporary directory the process runs in: data/workspace/<userId>
  // and the local file storage live under it.
  dir: string;
  // The listener's port on 127.0.0.1 — for a raw node:http client where
  // request() does not fit (a stream read as it flows).
  port: number;
  userId: string;
  mainThreadId: string;
  // The web session of the operator: `session_id=<token>`.
  cookie: string;
  request(method: string, urlPath: string, options?: RequestOptions): Promise<Reply>;
  // Releases everything the stand acquired — the listener and its open
  // connections (a stream the test left open does not hold it), the live
  // hub and the client, the cwd, the copy and the directory — each step on
  // its own; what failed is reported together once all of them ran. A
  // second call is a no-op.
  stop(): Promise<void>;
};

let started = false;

export async function startStand(): Promise<Stand> {
  if (started) {
    throw new Error('one stand per test file: the Prisma client of src/db/client.ts is one per process');
  }

  started = true;

  // Every resource goes on the cleanup the moment it is acquired, so a
  // failure anywhere below releases exactly what was taken by then.
  const cleanup = createCleanup();

  try {
    const db = await createTestDatabase();

    cleanup.add('drop the database copy', () => db.drop());

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'balabash-stand-'));

    cleanup.add('remove the directory', () => fs.rm(dir, { recursive: true, force: true }));

    for (const name of INHERITED_ENV) {
      delete process.env[name];
    }

    process.env.DATABASE_URL = db.url;
    process.env.SESSION_PEPPER = SESSION_PEPPER;
    process.env.FILE_STORAGE = 'local';

    const originalCwd = process.cwd();

    process.chdir(dir);
    cleanup.add('restore cwd', () => process.chdir(originalCwd));

    // The app's modules, after the environment is in place (the import
    // order above). The client is the one every module of the app shares.
    const { prisma } = await import('../db/client.ts');
    const { getLiveHub } = await import('../core/live.ts');
    const { ensureOperatorWorkspace } = await import('../core/threads.ts');
    const { createApiMiddleware, createFilesMiddleware } = await import('../api/api.ts');
    const { createAuthCode } = await import('../api/auth-codes.ts');

    cleanup.add('disconnect', async () => {
      getLiveHub().close();
      await prisma.$disconnect();
    });

    await checkDatabase(prisma, db.name);

    const app = new Koa();

    app.proxy = true;
    // The session-gated surfaces in the order src/api/index.ts mounts them.
    app.use(createFilesMiddleware());
    app.use(createApiMiddleware());
    app.use(ctx => {
      ctx.status = 404;
      ctx.body = 'Not found';
    });

    const server = http.createServer(app.callback());
    const { port } = await listen(server, 0, '127.0.0.1');

    cleanup.add('close the server', () => closeServer(server));

    const mainThread = await ensureOperatorWorkspace();
    const userId = mainThread.userId;

    let cookie = '';
    const request = (method: string, urlPath: string, options: RequestOptions = {}) =>
      send(port, method, urlPath, { ...options, cookie: options.cookie === undefined ? cookie : options.cookie });

    const signedIn = await request('POST', '/api/auth', { body: { code: createAuthCode(userId, 'console') } });

    if (signedIn.status !== 200) {
      throw new Error(`the stand could not sign in: ${signedIn.status} ${signedIn.text}`);
    }

    cookie = sessionCookie(signedIn.headers['set-cookie'] ?? []);

    return { db, dir, port, userId, mainThreadId: mainThread.id, cookie, request, stop: () => cleanup.run() };
  } catch (error) {
    // The failure of the start is the error; a failure of the cleanup
    // rides along with it rather than replacing it.
    try {
      await cleanup.run();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], `${describe(error)} — and the stand's cleanup failed: ${describe(cleanupError)}`);
    }

    throw error;
  }
}

// Everything acquired, released in the reverse order of acquisition, each
// step on its own: a step that fails never skips the ones after it, and
// the failures come back together once every step has run. run() empties
// the list — a second run() releases nothing twice.
export type Cleanup = {
  add(name: string, release: () => void | Promise<void>): void;
  run(): Promise<void>;
};

export function createCleanup(): Cleanup {
  const steps: { name: string; release: () => void | Promise<void> }[] = [];

  return {
    add(name, release) {
      steps.push({ name, release });
    },

    async run() {
      const failures: Error[] = [];

      while (steps.length) {
        const { name, release } = steps.pop()!;

        try {
          await release();
        } catch (error) {
          failures.push(new Error(`${name}: ${describe(error)}`, { cause: error }));
        }
      }

      if (failures.length) {
        throw new AggregateError(failures, `the stand's cleanup failed — ${failures.map(failure => failure.message).join('; ')}`);
      }
    },
  };
}

// Both outcomes of a listen: `listening`, or the `error` of a bind that did
// not happen (EADDRINUSE, EACCES, EMFILE — asynchronous, on the server
// object). Waiting for the first alone leaves the second an unhandled
// 'error' event, and the caller's cleanup never runs. Neither handler stays
// on the server afterwards.
export function listen(server: http.Server, port: number, host: string): Promise<AddressInfo> {
  return new Promise((resolve, reject) => {
    const onListening = () => {
      server.off('error', onError);
      resolve(server.address() as AddressInfo);
    };
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };

    server.once('listening', onListening);
    server.once('error', onError);
    server.listen(port, host);
  });
}

// server.close() alone waits for the active connections to end — and an
// event stream (GET /api/events/stream) never ends on its own; the idle
// ones it closes itself. The connections are the stand's: cut them, and
// the handlers see the close they wait for (the stream clears its
// heartbeat and unsubscribes from the hub).
export function closeServer(server: http.Server): Promise<void> {
  return new Promise(resolve => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// The second lock, before the first write: the client the app's modules
// share reaches the stand's copy (current_database() names it) and the
// template is still a template (a copy, not the template, is what a test
// writes to). A client built on the blocked address — db/client.ts imported
// before the stand — fails here with P1001 and the hint.
async function checkDatabase(prisma: { $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<T> }, name: string): Promise<void> {
  let rows: { name: string; template: boolean | null }[];

  try {
    rows = await prisma.$queryRaw<{ name: string; template: boolean | null }[]>`
      select current_database() as name, (select datistemplate from pg_database where datname = ${TEMPLATE_DATABASE}) as template`;
  } catch (error) {
    throw new Error(
      `the app's Prisma client does not reach the stand's database — import the app's modules dynamically after \`await startStand()\` ` +
        `(src/test-support/stand.ts): ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const [row] = rows;

  if (!row || row.name !== name) {
    throw new Error(`the app's Prisma client reaches "${row?.name}" instead of the stand's database "${name}"`);
  }

  if (row.template !== true) {
    throw new Error(`the template ${TEMPLATE_DATABASE} is not a template database`);
  }
}

// node:http rather than fetch: fetch drops a caller-set Host header, and
// the host and the forwarded protocol are what the session cookie and the
// console branch decide on.
function send(port: number, method: string, urlPath: string, options: RequestOptions): Promise<Reply> {
  const headers: Record<string, string> = {
    host: STAND_HOST,
    'x-forwarded-proto': 'https',
    ...(options.cookie ? { cookie: options.cookie } : {}),
    ...options.headers,
  };
  const text = options.text ?? (options.body === undefined ? undefined : JSON.stringify(options.body));

  if (text !== undefined) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(Buffer.byteLength(text));
  }

  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers, signal: options.signal }, res => {
      const chunks: Buffer[] = [];

      res.on('data', chunk => chunks.push(chunk as Buffer));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');

        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          text: body,
          json: <T>() => parseJson(body) as T,
        });
      });
      res.on('error', reject);
    });

    req.on('error', reject);

    if (text !== undefined) {
      req.write(text);
    }

    req.end();
  });
}

// The session cookie of a login response, as the browser would send it
// back: the host-only `session_id=<token>` pair (the response also expires
// the legacy domain cookie under the same name — that one is empty).
export function sessionCookie(setCookie: string[]): string {
  for (const header of setCookie) {
    const pair = header.split(';', 1)[0] ?? '';
    const [name, value] = pair.split('=');

    if (name === 'session_id' && value) {
      return pair;
    }
  }

  throw new Error(`no session cookie in the login response: ${JSON.stringify(setCookie)}`);
}
