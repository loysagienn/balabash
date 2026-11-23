// The vocabulary rules without a database: the registry families are
// canonical (any actor may write them — the agent's thread, the operator,
// the core), and an agent cannot take their first segment as its domain.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { AppendError, isCanonicalType, validateEnvelope } from './envelope.ts';

describe('registry events in the envelope', () => {
  test('the names of Settings changing is canonical, written by the operator', () => {
    assert.equal(isCanonicalType('settings.updated'), true);
    assert.equal(isCanonicalType('settings.cleared'), false);
    validateEnvelope({ type: 'settings.updated', actor: 'user', workspaceId: 'u', payload: { workspaceName: 'Home' } });
  });

  test('any actor may write them; a thread needs its user', () => {
    validateEnvelope({ type: 'project.created', actor: 'agent', agentName: 'coordinator', workspaceId: 'u', threadId: 'main', payload: {} });
    validateEnvelope({ type: 'app.published', actor: 'user', workspaceId: 'u', payload: {} });
    validateEnvelope({ type: 'schedule.task.cancelled', actor: 'system', workspaceId: 'u', payload: {} });
    assert.throws(() => validateEnvelope({ type: 'project.created', actor: 'agent', workspaceId: 'u', threadId: 'main', payload: {} }), AppendError);
  });
});

test('a task author names its run, has no agent name and cannot speak for the user or an agent session', () => {
  const event = { type: 'agent.message', actor: 'task' as const, workspaceId: 'ws', threadId: 'main', task: { slug: 'digest', runId: 'run' }, payload: {} };
  validateEnvelope(event);
  validateEnvelope({ ...event, type: 'tool.call.started' });
  for (const invalid of [
    { ...event, task: undefined }, { ...event, task: { slug: 'digest', runId: '' } },
    { ...event, agentName: 'coordinator' }, { ...event, actor: 'agent' as const, agentName: 'coordinator' },
    { ...event, threadId: null }, { ...event, type: 'digest.note' },
    { ...event, type: 'agent.ask' }, { ...event, type: 'session.state' }, { ...event, type: 'user.message' },
  ]) {
    assert.throws(() => validateEnvelope(invalid), AppendError);
  }
});
