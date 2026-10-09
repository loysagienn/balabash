import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { checkMutationOrigin } from './origin.ts';

const HOST = 'console.balabash.app';
const HTTPS = 'https';

describe('checkMutationOrigin', () => {
  test('reads pass whatever they carry', () => {
    assert.equal(checkMutationOrigin({ method: 'GET', protocol: HTTPS, host: HOST, secFetchSite: 'cross-site', origin: 'https://evil.example' }), 'ok');
    assert.equal(checkMutationOrigin({ method: 'head', protocol: HTTPS, host: HOST, secFetchSite: 'cross-site' }), 'ok');
  });

  test('fetch metadata decides when present', () => {
    assert.equal(checkMutationOrigin({ method: 'POST', protocol: HTTPS, host: HOST, secFetchSite: 'same-origin' }), 'ok');
    assert.equal(checkMutationOrigin({ method: 'POST', protocol: HTTPS, host: HOST, secFetchSite: 'none' }), 'ok');
    assert.equal(checkMutationOrigin({ method: 'POST', protocol: HTTPS, host: HOST, secFetchSite: 'same-site' }), 'cross-site');
    assert.equal(checkMutationOrigin({ method: 'POST', protocol: HTTPS, host: HOST, secFetchSite: 'cross-site' }), 'cross-site');
    // Metadata outranks a matching Origin.
    assert.equal(checkMutationOrigin({ method: 'DELETE', protocol: HTTPS, host: HOST, secFetchSite: 'cross-site', origin: `https://${HOST}` }), 'cross-site');
  });

  test('without metadata the Origin must be this very origin — scheme, host and port', () => {
    assert.equal(checkMutationOrigin({ method: 'POST', protocol: HTTPS, host: HOST, origin: `https://${HOST}` }), 'ok');
    assert.equal(checkMutationOrigin({ method: 'POST', protocol: HTTPS, host: HOST, origin: `https://${HOST.toUpperCase()}` }), 'ok');
    assert.equal(checkMutationOrigin({ method: 'PATCH', protocol: 'http', host: 'localhost:3000', origin: 'http://localhost:3000' }), 'ok');
    assert.equal(checkMutationOrigin({ method: 'POST', protocol: HTTPS, host: HOST, origin: 'https://balabash.app' }), 'cross-site');
    assert.equal(checkMutationOrigin({ method: 'POST', protocol: HTTPS, host: HOST, origin: 'null' }), 'cross-site');
    assert.equal(checkMutationOrigin({ method: 'POST', protocol: HTTPS, host: HOST, origin: 'not a url' }), 'cross-site');
    // The same host under another scheme or port is another origin.
    assert.equal(checkMutationOrigin({ method: 'POST', protocol: HTTPS, host: HOST, origin: `http://${HOST}` }), 'cross-site');
    assert.equal(checkMutationOrigin({ method: 'POST', protocol: 'http', host: HOST, origin: `https://${HOST}` }), 'cross-site');
    assert.equal(checkMutationOrigin({ method: 'POST', protocol: HTTPS, host: HOST, origin: `https://${HOST}:8443` }), 'cross-site');
    assert.equal(checkMutationOrigin({ method: 'POST', protocol: HTTPS, host: `${HOST}:443`, origin: `https://${HOST}` }), 'ok');
    assert.equal(checkMutationOrigin({ method: 'POST', protocol: HTTPS, host: HOST, origin: `https://${HOST}:443` }), 'ok');
    assert.equal(checkMutationOrigin({ method: 'POST', protocol: HTTPS, host: HOST, origin: `ftp://${HOST}` }), 'cross-site');
  });

  test('a request with neither header is not a browser page and passes', () => {
    assert.equal(checkMutationOrigin({ method: 'POST', protocol: HTTPS, host: HOST }), 'ok');
  });
});
