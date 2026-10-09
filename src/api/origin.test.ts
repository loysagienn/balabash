import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { checkMutationOrigin } from './origin.ts';

const HOST = 'console.balabash.app';

describe('checkMutationOrigin', () => {
  test('reads pass whatever they carry', () => {
    assert.equal(checkMutationOrigin({ method: 'GET', host: HOST, secFetchSite: 'cross-site', origin: 'https://evil.example' }), 'ok');
    assert.equal(checkMutationOrigin({ method: 'head', host: HOST, secFetchSite: 'cross-site' }), 'ok');
  });

  test('fetch metadata decides when present', () => {
    assert.equal(checkMutationOrigin({ method: 'POST', host: HOST, secFetchSite: 'same-origin' }), 'ok');
    assert.equal(checkMutationOrigin({ method: 'POST', host: HOST, secFetchSite: 'none' }), 'ok');
    assert.equal(checkMutationOrigin({ method: 'POST', host: HOST, secFetchSite: 'same-site' }), 'cross-site');
    assert.equal(checkMutationOrigin({ method: 'POST', host: HOST, secFetchSite: 'cross-site' }), 'cross-site');
    // Metadata outranks a matching Origin.
    assert.equal(checkMutationOrigin({ method: 'DELETE', host: HOST, secFetchSite: 'cross-site', origin: `https://${HOST}` }), 'cross-site');
  });

  test('without metadata the Origin must name this host', () => {
    assert.equal(checkMutationOrigin({ method: 'POST', host: HOST, origin: `https://${HOST}` }), 'ok');
    assert.equal(checkMutationOrigin({ method: 'POST', host: HOST, origin: `https://${HOST.toUpperCase()}` }), 'ok');
    assert.equal(checkMutationOrigin({ method: 'PATCH', host: 'localhost:3000', origin: 'http://localhost:3000' }), 'ok');
    assert.equal(checkMutationOrigin({ method: 'POST', host: HOST, origin: 'https://balabash.app' }), 'cross-site');
    assert.equal(checkMutationOrigin({ method: 'POST', host: HOST, origin: 'null' }), 'cross-site');
    assert.equal(checkMutationOrigin({ method: 'POST', host: HOST, origin: 'not a url' }), 'cross-site');
  });

  test('a request with neither header is not a browser page and passes', () => {
    assert.equal(checkMutationOrigin({ method: 'POST', host: HOST }), 'ok');
  });
});
