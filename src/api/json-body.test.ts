// The strict reading of a JSON request body: empty is {}, an object passes,
// anything else is a refusal with its reason.
//
// Run: npm test  (node:test, native type stripping — no build needed).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseJsonBody } from './json-body.ts';

describe('parseJsonBody', () => {
  it('reads an empty body as an empty object', () => {
    assert.deepEqual(parseJsonBody(''), { ok: true, body: {} });
    assert.deepEqual(parseJsonBody(' \n'), { ok: true, body: {} });
  });

  it('takes a JSON object as is, serialize-json markers restored', () => {
    assert.deepEqual(parseJsonBody('{"title":"T","description":null}'), {
      ok: true,
      body: { title: 'T', description: null },
    });
    assert.deepEqual(parseJsonBody('{"at":{"_$_type":"date","_$_value":"2026-10-09T00:00:00.000Z"}}'), {
      ok: true,
      body: { at: new Date('2026-10-09T00:00:00.000Z') },
    });
  });

  it('refuses malformed JSON', () => {
    assert.deepEqual(parseJsonBody('{'), { ok: false, message: 'the body is not valid JSON' });
    assert.deepEqual(parseJsonBody('{"title":'), { ok: false, message: 'the body is not valid JSON' });
  });

  it('refuses a body that is not an object', () => {
    for (const raw of ['[]', 'null', '42', '"text"', 'true']) {
      assert.deepEqual(parseJsonBody(raw), { ok: false, message: 'the body must be a JSON object' }, raw);
    }
  });
});
