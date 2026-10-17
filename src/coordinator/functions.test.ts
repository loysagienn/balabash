// The coordinator's spawn function of a remote kind: the kind's options
// schema in the strict function format (every property required and
// nullable, recursively; enums admit null; defaults become words), the
// nulls the model passes dropped again at the spawn.
//
// Run: npm test  (node:test, native type stripping — no build needed).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compactOptions, remoteSpawnParameters, strictNullableSchema } from './functions.ts';

describe('the remote spawn function', () => {
  it('makes the options schema strict and nullable, recursively', () => {
    const strict = strictNullableSchema({
      type: 'object',
      properties: {
        harness: { type: 'string', enum: ['pi', 'claude'], description: 'The harness.', default: 'pi' },
        resources: { type: 'object', properties: { cpu: { type: 'integer' }, tags: { type: 'array', items: { type: 'string' } } } },
      },
    });

    assert.deepEqual(strict, {
      type: ['object', 'null'],
      properties: {
        harness: { type: ['string', 'null'], enum: ['pi', 'claude', null], description: 'The harness. Default: "pi".' },
        resources: {
          type: ['object', 'null'],
          properties: { cpu: { type: ['integer', 'null'] }, tags: { type: ['array', 'null'], items: { type: ['string', 'null'] } } },
          required: ['cpu', 'tags'],
          additionalProperties: false,
        },
      },
      required: ['harness', 'resources'],
      additionalProperties: false,
    });
  });

  it('takes exactly the six parameters, the options by the kind’s schema', () => {
    const parameters = remoteSpawnParameters({ options: { type: 'object', properties: { effort: { type: 'string' } } } }) as { required: string[]; properties: Record<string, { type: unknown; required?: string[] }> };

    assert.deepEqual(parameters.required, ['prompt', 'adopt', 'fileIds', 'thread_title', 'project', 'options']);
    assert.deepEqual(parameters.properties.options.type, ['object', 'null']);
    assert.deepEqual(parameters.properties.options.required, ['effort']);
    assert.deepEqual((remoteSpawnParameters({}) as typeof parameters).properties.options.required, []);
  });

  it('drops the nulls of the options the model named', () => {
    assert.deepEqual(compactOptions({ harness: 'pi', model: null, resources: { cpu: null, memory_gib: 8 }, empty: { a: null } }), { harness: 'pi', resources: { memory_gib: 8 } });
    assert.deepEqual(compactOptions(null), {});
  });
});
