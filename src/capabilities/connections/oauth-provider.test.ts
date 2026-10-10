import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { registrationServesRedirect } from './oauth-provider.ts';

const REDIRECT = 'https://console.example/oauth/callback';

describe('registrationServesRedirect', () => {
  it('accepts a dynamic registration that names the redirect URI', () => {
    assert.equal(registrationServesRedirect({ client_id: 'c', redirect_uris: [REDIRECT] }, REDIRECT), true);
    assert.equal(
      registrationServesRedirect({ client_id: 'c', redirect_uris: ['https://other.example/cb', REDIRECT] }, REDIRECT),
      true,
    );
  });

  it('compares URIs as the browser reads them, not as strings', () => {
    assert.equal(
      registrationServesRedirect({ client_id: 'c', redirect_uris: ['HTTPS://Console.Example:443/oauth/callback'] }, REDIRECT),
      true,
    );
  });

  it('rejects a dynamic registration bound to another redirect URI', () => {
    assert.equal(
      registrationServesRedirect({ client_id: 'c', redirect_uris: ['https://old.example/oauth/callback'] }, REDIRECT),
      false,
    );
    assert.equal(registrationServesRedirect({ client_id: 'c', redirect_uris: [] }, REDIRECT), false);
    assert.equal(registrationServesRedirect({ client_id: 'c', redirect_uris: [42] } as never, REDIRECT), false);
  });

  it('never judges a client without redirect_uris — a manually provisioned one', () => {
    assert.equal(registrationServesRedirect({ client_id: 'c', client_secret: 's' }, REDIRECT), true);
    assert.equal(registrationServesRedirect({ client_id: 'c', redirect_uris: 'not-a-list' } as never, REDIRECT), true);
  });
});
