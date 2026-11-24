// The blocked list of a user's browser (sites.ts): how an entry is kept and
// which addresses it covers.
//
// Run: npm test  (node:test, native type stripping — no build needed).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isBlockedUrl, isExtensionPage, normalizeSite, normalizeSites } from './sites.ts';

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

  test('named in Cyrillic covers the address, which names it in punycode — and the other way round', () => {
    for (const list of [['банк.рф'], ['xn--80ab2al.xn--p1ai'], normalizeSites(['https://БАНК.рф/вход'])]) {
      for (const url of ['https://банк.рф/', 'https://xn--80ab2al.xn--p1ai/account', 'https://online.банк.рф/', 'https://online.xn--80ab2al.xn--p1ai/']) {
        assert.equal(isBlockedUrl(url, list), true, `${url} in ${JSON.stringify(list)}`);
      }

      assert.equal(isBlockedUrl('https://небанк.рф/', list), false);
    }

    assert.deepEqual(normalizeSites(['банк.рф', 'xn--80ab2al.xn--p1ai', 'БАНК.РФ']), ['банк.рф'], 'a name and its punycode are one site');
  });
});

describe('a page of an extension', () => {
  test('is told by its scheme, whatever the extension and the case', () => {
    for (const url of ['chrome-extension://moadcglcgjkicomjkmccjfckhoeohhck/popup.html', 'CHROME-EXTENSION://abc/consent.html?id=1', '  chrome-extension://abc/']) {
      assert.equal(isExtensionPage(url), true, url);
    }

    for (const url of ['https://example.com/chrome-extension://abc/', 'about:blank', 'chrome://extensions/', '', undefined]) {
      assert.equal(isExtensionPage(url), false, String(url));
    }
  });
});
