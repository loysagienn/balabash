import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { readField } from './identity.ts';

describe('readField — a probe answer field by path', () => {
  test('a top-level name reads the field as before', () => {
    assert.equal(readField({ emailAddress: 'anna@example.com' }, 'emailAddress'), 'anna@example.com');
  });

  test('a dotted path walks nested objects (Drive wraps the account in "user")', () => {
    assert.equal(readField({ user: { emailAddress: 'anna@example.com', permissionId: '42' } }, 'user.emailAddress'), 'anna@example.com');
    assert.equal(readField({ user: { permissionId: 42 } }, 'user.permissionId'), 42);
  });

  test('a path that breaks — a missing segment, a scalar or an array on the way — is undefined, never a throw', () => {
    assert.equal(readField({ user: { emailAddress: 'a' } }, 'user.id'), undefined);
    assert.equal(readField({ user: 'anna' }, 'user.emailAddress'), undefined);
    assert.equal(readField({ user: [{ emailAddress: 'a' }] }, 'user.emailAddress'), undefined);
    assert.equal(readField(null, 'user'), undefined);
    assert.equal(readField({ emailAddress: 'a' }, 'missing'), undefined);
  });
});
