import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SecretRequestField } from '../../../api/contract.ts';
import { REQUIRED_ERROR, missingRequired, provisionValues, secretsFailure, secretsTitle, submitLabel } from './Secrets.logic.ts';

const FIELDS: SecretRequestField[] = [
  { key: 'client_id', label: 'Client ID', description: 'OAuth client identifier issued by the provider', required: true, secret: false },
  { key: 'client_secret', label: 'Client secret', description: 'Leave empty for a public client', required: false, secret: true },
];

describe('secret entry logic', () => {
  it('names the card by the kind of request', () => {
    assert.equal(secretsTitle({ kind: 'oauth-client', server: 'notion' }), 'OAuth client for notion');
    assert.equal(secretsTitle({ kind: 'external-secrets', server: 'github' }), 'Secrets for github');
  });

  it('finds the required fields still empty, whitespace included', () => {
    assert.deepEqual(missingRequired(FIELDS, {}), { client_id: REQUIRED_ERROR });
    assert.deepEqual(missingRequired(FIELDS, { client_id: '  \n' }), { client_id: REQUIRED_ERROR });
    assert.deepEqual(missingRequired(FIELDS, { client_id: 'abc' }), {});
    // An optional field may stay empty.
    assert.deepEqual(missingRequired(FIELDS, { client_id: 'abc', client_secret: '' }), {});
  });

  it('sends every field of the request, trimmed, and nothing else', () => {
    assert.deepEqual(provisionValues(FIELDS, { client_id: ' abc\n', extra: 'x' }), { client_id: 'abc', client_secret: '' });
    assert.deepEqual(provisionValues(FIELDS, { client_id: 'abc', client_secret: ' s3cret ' }), { client_id: 'abc', client_secret: 's3cret' });
  });

  it('reads a failed call', () => {
    assert.deepEqual(secretsFailure({ status: 404, code: 'not_found', message: 'No such secret request — it may already be fulfilled' }), { kind: 'expired' });
    assert.deepEqual(secretsFailure({ status: 401, code: 'unauthorized', message: 'Sign in' }), { kind: 'session' });
    assert.deepEqual(secretsFailure({ status: 400, code: 'provisioning_failed', message: 'Client ID is required' }), { kind: 'failed', message: 'Client ID is required' });
    assert.deepEqual(secretsFailure({ status: 0, code: 'network', message: 'Failed to fetch' }), { kind: 'failed', message: 'Failed to fetch' });
  });

  it('names what the button waits for', () => {
    assert.equal(submitLabel(false), 'Save');
    assert.equal(submitLabel(true), 'Saving');
  });
});
