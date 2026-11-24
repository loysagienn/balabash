// The blocked list of a user's browser (sites.ts): how an entry is kept and
// which addresses it covers.
//
// Run: npm test  (node:test, native type stripping — no build needed).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isBlockedUrl, normalizeSite, normalizeSites } from './sites.ts';

describe('an entry of the blocked list', () => {
  test('is kept as a bare host, whatever the user pasted', () => {
    assert.equal(normalizeSite('  Bank.Example.com '), 'bank.example.com');
    assert.equal(normalizeSite('https://www.example.com/login?next=1#top'), 'example.com');
    assert.equal(normalizeSite('*.example.com'), 'example.com');
    assert.equal(normalizeSite('user@mail.example.com:8443/inbox'), 'mail.example.com');
    assert.equal(normalizeSite('localhost'), 'localhost');
    assert.equal(normalizeSite('банк.рф'), 'банк.рф');
  });

  test('that names no host is dropped; repeats are kept once', () => {
    for (const input of ['', '   ', 'https://', 'not a site', 'a b.com', '/path/only']) {
      assert.equal(normalizeSite(input), null, JSON.stringify(input));
    }

    assert.deepEqual(normalizeSites(['Example.com', 'https://example.com/', '', 'bank.test', 'nope nope']), ['example.com', 'bank.test']);
  });
});

describe('a blocked site', () => {
  const sites = ['example.com', 'bank.test'];

  test('covers its own host and its subdomains, on any scheme, port and path', () => {
    for (const url of ['https://example.com/', 'http://EXAMPLE.com:8080/a?b#c', 'https://mail.example.com/inbox', 'https://a.b.bank.test/', 'https://example.com./']) {
      assert.equal(isBlockedUrl(url, sites), true, url);
    }
  });

  test('covers no other site: a host that only ends alike, a host in the path, an address without a host', () => {
    for (const url of ['https://notexample.com/', 'https://example.com.evil.test/', 'https://evil.test/?u=https://example.com/', 'about:blank', 'data:text/html,example.com', 'chrome://newtab/', '', undefined]) {
      assert.equal(isBlockedUrl(url, sites), false, String(url));
    }

    assert.equal(isBlockedUrl('https://example.com/', []), false);
  });
});
