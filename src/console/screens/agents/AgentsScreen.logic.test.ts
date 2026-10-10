import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { activityCaption, agentMatches, agentsDetail, agentsShell, agentsSummary, catalogModel, effortWords, emptyActivity, modeLabel, modelWords, withAgentsFilters } from './AgentsScreen.logic.ts';

describe('agents screen rules', () => {
  it('matches the search against the name and the description, case-insensitive', () => {
    const agent = { name: 'engineer', description: 'Balabash code and scripts' };

    assert.equal(agentMatches(agent, undefined), true);
    assert.equal(agentMatches(agent, '  '), true);
    assert.equal(agentMatches(agent, 'ENG'), true);
    assert.equal(agentMatches(agent, 'scripts'), true);
    assert.equal(agentMatches(agent, 'browser'), false);
  });

  it('names the mode', () => {
    assert.equal(modeLabel(true), 'headless · no user surface');
    assert.equal(modeLabel(false), 'with the user · not headless');
  });

  it('names the model of a row: the declared one, else the newest session’s, else the engine’s unseen default', () => {
    assert.equal(catalogModel({ model: 'claude-opus-5-5', lastModel: 'claude-opus-5-5-20260301' }), 'claude-opus-5-5');
    assert.equal(catalogModel({ model: null, lastModel: 'claude-opus-5-5' }), 'claude-opus-5-5');
    assert.equal(catalogModel({ model: null, lastModel: null }), 'default model');
  });

  it('words the model setting: a named model with a note when the newest session ran on another id, the resolved default, or nothing seen', () => {
    assert.deepEqual(modelWords({ model: 'claude-opus-5-5', lastModel: null }), { value: 'claude-opus-5-5', note: null });
    assert.deepEqual(modelWords({ model: 'claude-opus-5-5', lastModel: 'claude-opus-5-5' }), { value: 'claude-opus-5-5', note: null });
    assert.deepEqual(modelWords({ model: 'opus', lastModel: 'claude-opus-5-5' }), { value: 'opus', note: 'last session ran claude-opus-5-5' });
    assert.deepEqual(modelWords({ model: null, lastModel: 'claude-opus-5-5' }), { value: 'claude-opus-5-5', note: 'default of the engine · last session' });
    assert.deepEqual(modelWords({ model: null, lastModel: null }), { value: null, note: 'default of the engine' });
  });

  it('words the effort setting: the named one, the platform default a session runs with, or the model’s own', () => {
    assert.deepEqual(effortWords({ effort: 'max', defaultEffort: 'high' }), { value: 'max', note: null });
    assert.deepEqual(effortWords({ effort: null, defaultEffort: 'high' }), { value: 'high', note: 'default of the platform' });
    assert.deepEqual(effortWords({ effort: null, defaultEffort: null }), { value: null, note: 'default of the model' });
  });

  it('summarizes the catalog', () => {
    assert.equal(agentsSummary(11, 4), '11 agents · 4 active threads');
    assert.equal(agentsSummary(1, 1), '1 agent · 1 active thread');
    assert.equal(agentsSummary(0, 0), '0 agents · 0 active threads');
  });

  it('captions the activity with the whole count, the recent one and the running ones, each when known', () => {
    assert.equal(activityCaption(214, 61, 2), '214 threads · 61 in 30 days · 2 running');
    assert.equal(activityCaption(1214, 0, 0), '1,214 threads · 0 in 30 days');
    assert.equal(activityCaption(1, null, 0), '1 thread');
    assert.equal(activityCaption(null, 61, 1), '1 running');
    assert.equal(activityCaption(null, null, 0), undefined);
    assert.equal(activityCaption(0, 0, 0), undefined);
  });

  it('tells an agent without threads from one whose threads are older than the window', () => {
    assert.deepEqual(emptyActivity('scheduler', 0), { title: 'No threads yet', note: 'Threads of scheduler appear here as it works.' });
    assert.deepEqual(emptyActivity('scheduler', 1), { title: 'No recent threads', note: 'scheduler has 1 thread, all older than the recent ones shown here; the full list has them.' });
    assert.deepEqual(emptyActivity('scheduler', 1214), { title: 'No recent threads', note: 'scheduler has 1,214 threads, all older than the recent ones shown here; the full list has them.' });
    assert.deepEqual(emptyActivity('scheduler', null), { title: 'No recent threads', note: 'Nothing recent from scheduler; its earlier threads are in the full list.' });
  });

  it('writes the next route of a filter change without empty keys', () => {
    assert.deepEqual(withAgentsFilters({ key: 'agents', name: 'engineer', q: 'x' }, { q: '' }), { key: 'agents', name: 'engineer' });
    assert.deepEqual(withAgentsFilters({ key: 'agents', q: 'x' }, { name: 'codex' }), { key: 'agents', name: 'codex', q: 'x' });
    assert.deepEqual(withAgentsFilters({ key: 'agents', name: 'codex' }, { name: undefined }), { key: 'agents' });
  });

  it('tells what the details panel shows: the named agent, an unknown name once the catalog is in, the first snapshot in flight, or nothing picked', () => {
    assert.equal(agentsDetail(undefined, false, 'loading'), 'pick');
    assert.equal(agentsDetail(undefined, false, 'ready'), 'pick');
    assert.equal(agentsDetail('engineer', true, 'ready'), 'agent');
    assert.equal(agentsDetail('nope', false, 'ready'), 'unknown');
    assert.equal(agentsDetail('engineer', false, 'loading'), 'loading');
    assert.equal(agentsDetail('engineer', false, 'failed'), 'loading');
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
