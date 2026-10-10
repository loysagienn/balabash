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

  it('compares the registered string with the one the SDK sends — no URL normalization (RFC 6749 §3.1.2.3)', () => {
    const variants = [
      'https://console.example:443/oauth/callback',
      'HTTPS://console.example/oauth/callback',
      'https://Console.Example/oauth/callback',
      'https://console.example/oauth/callback/',
      'https://console.example/oauth/callback?x=1',
      'https://console.example/oauth/callback#f',
      'https://console.example/oauth/Callback',
      'https://console.example/./oauth/callback',
      ' https://console.example/oauth/callback',
    ];

    for (const uri of variants) {
      assert.equal(registrationServesRedirect({ client_id: 'c', redirect_uris: [uri] }, REDIRECT), false, uri);
    }
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
