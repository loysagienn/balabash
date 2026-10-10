import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { startedModel } from './last-model.ts';

describe('startedModel', () => {
  it('reads the model a start names, and null for a start naming none', () => {
    assert.equal(startedModel({ model: 'claude-opus-5-5', tools: [], mcpServers: [] }), 'claude-opus-5-5');
    assert.equal(startedModel({ tools: [], mcpServers: [] }), null);
    assert.equal(startedModel({ model: '' }), null);
    assert.equal(startedModel({ model: null }), null);
    assert.equal(startedModel({ model: 7 }), null);
    assert.equal(startedModel({}), null);
  });
});
