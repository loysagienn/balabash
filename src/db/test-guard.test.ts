// The lock between the tests and the live database (test-guard.ts): which
// connection strings a test child may keep, and that outside a test child
// nothing changes. The decision is checked against the driver's own reading
// of the string — where a pg.Client built on it would dial.
//
// Run: npm test  (node:test, native type stripping — no build needed).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import pg from 'pg';
import { BLOCKED_DATABASE_URL, isLocalTestDatabaseUrl, testSafeDatabaseUrl } from './test-guard.ts';

const PRODUCTION = 'postgresql://user:secret@db-postgresql-ams3-example.l.db.ondigitalocean.com:25060/balabash_v2?sslmode=verify-full';
const STAND = 'postgresql://balabash:balabash@127.0.0.1:54321/t1_ab12_test';
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

// Where the driver would dial on this string — nothing is opened.
function dials(url: string): { host: string; port: number; database: string | undefined } {
  const { host, port, database } = new pg.Client({ connectionString: url });
  return { host, port, database };
}

describe('isLocalTestDatabaseUrl', () => {
  it('accepts a loopback host with a `_test` database', () => {
    assert.equal(isLocalTestDatabaseUrl(STAND), true);
    assert.equal(isLocalTestDatabaseUrl('postgres://u:p@localhost/balabash_test'), true);
    assert.equal(isLocalTestDatabaseUrl('postgresql://u:p@[::1]:5432/x_test?schema=public'), true);
  });

  it('refuses a remote host, a database without the suffix, another scheme and a string that is no URL', () => {
    assert.equal(isLocalTestDatabaseUrl(PRODUCTION), false);
    assert.equal(isLocalTestDatabaseUrl('postgresql://u:p@db.example.com/balabash_test'), false);
    assert.equal(isLocalTestDatabaseUrl('postgresql://u:p@127.0.0.1:5432/balabash_v2'), false);
    assert.equal(isLocalTestDatabaseUrl('postgresql://u:p@127.0.0.1:5432/'), false);
    assert.equal(isLocalTestDatabaseUrl('mysql://u:p@127.0.0.1/x_test'), false);
    assert.equal(isLocalTestDatabaseUrl('not a url'), false);
  });

  it('is not fooled by the suffix elsewhere in the string', () => {
    assert.equal(isLocalTestDatabaseUrl('postgresql://u:p@127.0.0.1/balabash_v2?application_name=x_test'), false);
    assert.equal(isLocalTestDatabaseUrl('postgresql://x_test:p@127.0.0.1/balabash_v2'), false);
  });

  it('decides on the host the driver dials, not on the authority: a query `host` wins over a loopback authority', () => {
    const remote = [
      'postgresql://u:p@127.0.0.1:54321/example_test?host=db.example.invalid&port=25060',
      'postgresql://u:p@127.0.0.1:54321/example_test?host=%64b.example.invalid',
      'postgresql://u:p@127.0.0.1:54321/example_test?host=127.0.0.1&host=db.example.invalid',
      'postgresql://u:p@127.0.0.1:54321/example_test?host=/var/run/postgresql',
      'postgresql://u:p@127.0.0.1,db.example.invalid:5432/example_test',
    ];

    for (const url of remote) {
      assert.equal(isLocalTestDatabaseUrl(url), false, url);
      assert.equal(LOOPBACK.has(dials(url).host), false, `the driver does dial elsewhere on ${url}`);
    }
  });

  it('accepts what the driver resolves to the loopback, whatever the authority says', () => {
    const local = [
      'postgresql://u:p@127.0.0.1/x_test?port=54321',
      'postgresql:///x_test?host=127.0.0.1&port=54321',
      'postgresql://u:p@localhost/x_test?sslmode=disable',
    ];

    for (const url of local) {
      assert.equal(isLocalTestDatabaseUrl(url), true, url);
      assert.equal(LOOPBACK.has(dials(url).host), true, url);
      assert.match(dials(url).database ?? '', /_test$/);
    }
  });

  it('refuses, without throwing, a string the driver cannot read — and reads the rest the way the driver does', () => {
    assert.equal(isLocalTestDatabaseUrl('postgresql://u:p@127.0.0.1/x_test%'), false);
    assert.equal(isLocalTestDatabaseUrl('postgresql://u:p@127.0.0.1/x%C3%28_test'), false);
    assert.equal(isLocalTestDatabaseUrl('postgresql://u:p@127.0.0.1/x_test?sslrootcert=/nonexistent/ca.pem'), false);
    assert.equal(isLocalTestDatabaseUrl('postgresql://u:p@127.0.0.1:abc/x_test'), false);
    // Not every odd percent sign is an error to the driver: it keeps this one
    // as a literal and dials the loopback for a database named `bad%ZZ_test`.
    assert.equal(isLocalTestDatabaseUrl('postgresql://u:p@127.0.0.1/bad%ZZ_test'), true);
    assert.deepEqual(dials('postgresql://u:p@127.0.0.1/bad%ZZ_test'), { host: '127.0.0.1', port: 5432, database: 'bad%ZZ_test' });
  });
});

describe('testSafeDatabaseUrl', () => {
  it('keeps a local test database in a test child', () => {
    assert.equal(testSafeDatabaseUrl(STAND, 'child-v8'), STAND);
  });

  it('replaces anything else in a test child, an unset variable and a malformed one included', () => {
    assert.equal(testSafeDatabaseUrl(PRODUCTION, 'child-v8'), BLOCKED_DATABASE_URL);
    assert.equal(testSafeDatabaseUrl(undefined, 'child-v8'), BLOCKED_DATABASE_URL);
    assert.equal(testSafeDatabaseUrl('', 'child'), BLOCKED_DATABASE_URL);
    assert.equal(testSafeDatabaseUrl('postgresql://u:p@127.0.0.1/x%C3%28_test', 'child-v8'), BLOCKED_DATABASE_URL);
    assert.equal(testSafeDatabaseUrl('postgresql://u:p@127.0.0.1/x_test?host=db.example.invalid', 'child-v8'), BLOCKED_DATABASE_URL);
  });

  it('changes nothing outside a test child', () => {
    assert.equal(testSafeDatabaseUrl(PRODUCTION, undefined), PRODUCTION);
    assert.equal(testSafeDatabaseUrl(undefined, undefined), undefined);
    assert.equal(testSafeDatabaseUrl('', undefined), '');
    assert.equal(testSafeDatabaseUrl(PRODUCTION, ''), PRODUCTION);
  });

  it('blocks on an address that refuses at once', () => {
    const blocked = dials(BLOCKED_DATABASE_URL);

    assert.equal(blocked.host, '127.0.0.1');
    assert.equal(blocked.port, 1);
    assert.equal(isLocalTestDatabaseUrl(BLOCKED_DATABASE_URL), true);
  });
});
