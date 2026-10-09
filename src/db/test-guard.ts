// The one lock between the tests and the live database. `npm test` runs in
// a shell that inherits the app's environment, DATABASE_URL of the managed
// production database included, and any test that imports a module of the
// app graph imports db/client.ts with it — so under node:test the client is
// built on the connection string only when it names a local test database
// (localhost or a loopback address, a database name ending in `_test` — what
// the test PostgreSQL of src/test-support hands out), and on an unreachable
// address otherwise. Unreachable, not a throw at import: the tests of pure
// functions import the same modules and must not care about databases, and
// the first real query of a test that forgot the stand fails at once with a
// connection refused instead of touching production.
//
// node sets NODE_TEST_CONTEXT in every test child it spawns (`child-v8`
// today; the name is the contract, the value is not), so the lock is on
// `npm test` and `node --test <file>`, not on `node <file>`.

export const BLOCKED_DATABASE_URL = 'postgresql://blocked:blocked@127.0.0.1:1/blocked_test';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function isLocalTestDatabaseUrl(url: string): boolean {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    return false;
  }

  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));

  return LOCAL_HOSTS.has(parsed.hostname) && database.endsWith('_test');
}

// The connection string the Prisma client may use, given the environment:
// outside a test child the configured one (`undefined` keeps the config's
// own "is not set" refusal), inside one only a local test database.
export function testSafeDatabaseUrl(url: string | undefined, testContext: string | undefined): string | undefined {
  if (!testContext) {
    return url;
  }

  return url !== undefined && isLocalTestDatabaseUrl(url) ? url : BLOCKED_DATABASE_URL;
}
