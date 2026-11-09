import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { registrationFromAuthorizationServer, registrationServesRedirect } from './oauth-provider.ts';

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

describe('registrationFromAuthorizationServer', () => {
  const ID = 'https://id.example';

  it('accepts a registration stamped with the given authorization server', () => {
    assert.equal(registrationFromAuthorizationServer({ client_id: 'c', authorization_server: ID } as never, ID), true);
  });

  it('compares issuers as origins — a trailing slash is not another server', () => {
    assert.equal(
      registrationFromAuthorizationServer({ client_id: 'c', authorization_server: `${ID}/` } as never, ID),
      true,
    );
    assert.equal(
      registrationFromAuthorizationServer({ client_id: 'c', authorization_server: ID } as never, `${ID}/`),
      true,
    );
  });

  it('rejects a registration obtained from another authorization server', () => {
    assert.equal(
      registrationFromAuthorizationServer(
        { client_id: 'c', authorization_server: 'https://mcp.example/mcp' } as never,
        ID,
      ),
      false,
    );
    assert.equal(
      registrationFromAuthorizationServer({ client_id: 'c', authorization_server: 'HTTPS://id.example' } as never, ID),
      false,
    );
  });

  it('never judges a registration without a stamp — saved before the stamp, or provisioned by hand', () => {
    assert.equal(registrationFromAuthorizationServer({ client_id: 'c', redirect_uris: ['https://x/cb'] }, ID), true);
    assert.equal(registrationFromAuthorizationServer({ client_id: 'c', client_secret: 's' }, ID), true);
    assert.equal(registrationFromAuthorizationServer({ client_id: 'c', authorization_server: 42 } as never, ID), true);
  });
});
