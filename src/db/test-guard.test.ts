// The lock between the tests and the live database (test-guard.ts): which
// connection strings a test child may keep, and that outside a test child
// nothing changes.
//
// Run: npm test  (node:test, native type stripping — no build needed).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BLOCKED_DATABASE_URL, isLocalTestDatabaseUrl, testSafeDatabaseUrl } from './test-guard.ts';

const PRODUCTION = 'postgresql://user:secret@db-postgresql-ams3-example.l.db.ondigitalocean.com:25060/balabash_v2?sslmode=verify-full';
const STAND = 'postgresql://balabash:balabash@127.0.0.1:54321/t1_ab12_test';

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
});

describe('testSafeDatabaseUrl', () => {
  it('keeps a local test database in a test child', () => {
    assert.equal(testSafeDatabaseUrl(STAND, 'child-v8'), STAND);
  });

  it('replaces anything else in a test child, an unset variable included', () => {
    assert.equal(testSafeDatabaseUrl(PRODUCTION, 'child-v8'), BLOCKED_DATABASE_URL);
    assert.equal(testSafeDatabaseUrl(undefined, 'child-v8'), BLOCKED_DATABASE_URL);
    assert.equal(testSafeDatabaseUrl('', 'child'), BLOCKED_DATABASE_URL);
  });

  it('changes nothing outside a test child', () => {
    assert.equal(testSafeDatabaseUrl(PRODUCTION, undefined), PRODUCTION);
    assert.equal(testSafeDatabaseUrl(undefined, undefined), undefined);
    assert.equal(testSafeDatabaseUrl(PRODUCTION, ''), PRODUCTION);
  });

  it('blocks on an address that refuses at once', () => {
    const blocked = new URL(BLOCKED_DATABASE_URL);

    assert.equal(blocked.hostname, '127.0.0.1');
    assert.equal(blocked.port, '1');
    assert.equal(isLocalTestDatabaseUrl(BLOCKED_DATABASE_URL), true);
  });
});
