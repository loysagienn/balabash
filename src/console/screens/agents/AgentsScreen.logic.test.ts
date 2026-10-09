import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { agentMatches, agentsShell, agentsSummary, engineLabel, engineName, modeLabel, withAgentsFilters } from './AgentsScreen.logic.ts';

describe('agents screen rules', () => {
  it('matches the search against the name and the description, case-insensitive', () => {
    const agent = { name: 'engineer', description: 'Balabash code and scripts' };

    assert.equal(agentMatches(agent, undefined), true);
    assert.equal(agentMatches(agent, '  '), true);
    assert.equal(agentMatches(agent, 'ENG'), true);
    assert.equal(agentMatches(agent, 'scripts'), true);
    assert.equal(agentMatches(agent, 'browser'), false);
  });

  it('names the engine and the mode', () => {
    assert.equal(engineLabel('claude'), 'Claude');
    assert.equal(engineLabel('codex'), 'Codex');
    assert.equal(engineName('claude'), 'Claude Agent SDK');
    assert.equal(engineName('codex'), 'Codex SDK');
    assert.equal(modeLabel(true), 'headless · no user surface');
    assert.equal(modeLabel(false), 'with the user · not headless');
  });

  it('summarizes the catalog', () => {
    assert.equal(agentsSummary(11, 4), '11 agents · 4 active threads');
    assert.equal(agentsSummary(1, 1), '1 agent · 1 active thread');
    assert.equal(agentsSummary(0, 0), '0 agents · 0 active threads');
  });

  it('writes the next route of a filter change without empty keys', () => {
    assert.deepEqual(withAgentsFilters({ key: 'agents', name: 'engineer', q: 'x' }, { q: '' }), { key: 'agents', name: 'engineer' });
    assert.deepEqual(withAgentsFilters({ key: 'agents', q: 'x' }, { name: 'codex' }), { key: 'agents', name: 'codex', q: 'x' });
    assert.deepEqual(withAgentsFilters({ key: 'agents', name: 'codex' }, { name: undefined }), { key: 'agents' });
  });

  it('shapes the shell: the catalog is the section, a selected agent is a detail screen on the phone only', () => {
    assert.deepEqual(agentsShell({ key: 'agents' }), { title: 'Agents', detail: false });
    assert.deepEqual(agentsShell({ key: 'agents', q: 'en' }), { title: 'Agents', detail: false });
    assert.deepEqual(agentsShell({ key: 'agents', name: 'engineer', q: 'en' }), {
      title: 'Agents',
      titleNarrow: 'engineer',
      back: { key: 'agents', q: 'en' },
      backNarrow: true,
      detail: true,
    });
  });
});
