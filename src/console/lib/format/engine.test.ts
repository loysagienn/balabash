import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { engineLabel, engineName } from './engine.ts';

describe('engine words', () => {
  it('names each engine for a row and for the details', () => {
    assert.equal(engineLabel('claude'), 'Claude');
    assert.equal(engineLabel('codex'), 'Codex');
    assert.equal(engineLabel('openai'), 'OpenAI');
    assert.equal(engineName('claude'), 'Claude Agent SDK');
    assert.equal(engineName('codex'), 'Codex SDK');
    assert.equal(engineName('openai'), 'OpenAI Responses API');
  });
});
