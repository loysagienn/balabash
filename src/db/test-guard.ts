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

import pg from 'pg';

export const BLOCKED_DATABASE_URL = 'postgresql://blocked:blocked@127.0.0.1:1/blocked_test';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

// The decision is on where the driver would dial, not on URL.hostname: pg
// reads the string through pg-connection-string, which lets `?host=` and
// `?port=` in the query override the authority, percent-decodes them, takes
// a socket path for a host and falls back to PGHOST and `localhost` when the
// authority is empty — so a loopback authority proves nothing. A pg.Client
// built on the string resolves all of that the way PrismaPg's pool will and
// opens nothing until connect(); any string it cannot read (a malformed
// percent-encoding, a bad port, an unreadable ssl file) is refused.
export function isLocalTestDatabaseUrl(url: string): boolean {
  try {
    const parsed = new URL(url);

    if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
      return false;
    }

    const { host, database } = new pg.Client({ connectionString: url });

    return LOCAL_HOSTS.has(host) && typeof database === 'string' && database.endsWith('_test');
  } catch {
    return false;
  }
}

// The connection string the Prisma client may use, given the environment:
// outside a test child the configured one, untouched (client.ts falls back
// to the config's own "is not set" refusal for an unset or empty variable),
// inside one only a local test database.
export function testSafeDatabaseUrl(url: string | undefined, testContext: string | undefined): string | undefined {
  if (!testContext) {
    return url;
  }

  return url !== undefined && isLocalTestDatabaseUrl(url) ? url : BLOCKED_DATABASE_URL;
}
