import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AgentView } from '../../../api/contract.ts';
import { agentOf } from './selectors.ts';

const engineer: AgentView = { name: 'engineer', description: 'code', icon: null, sdk: 'claude', tools: ['events'], agents: [], headless: false, notification: null, model: null, effort: null };

describe('agent of the catalog', () => {
  it('finds an own entry and nothing else — not a key of Object.prototype', () => {
    const byName = { engineer };

    assert.equal(agentOf(byName, 'engineer'), engineer);
    assert.equal(agentOf(byName, 'nope'), null);
    assert.equal(agentOf(byName, 'constructor'), null);
    assert.equal(agentOf(byName, '__proto__'), null);
    assert.equal(agentOf(byName, 'toString'), null);
    assert.equal(agentOf({}, 'hasOwnProperty'), null);
  });
});
