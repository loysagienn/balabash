// The vocabulary rules without a database: the registry families are
// canonical (any actor may write them — the agent's thread, the operator,
// the core), and an agent cannot take their first segment as its domain.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { AppendError, RESERVED_DOMAINS, isCanonicalType, validateEnvelope } from './envelope.ts';

describe('registry events in the envelope', () => {
  test('the registry families are canonical', () => {
    for (const type of ['project.created', 'project.unarchived', 'schedule.task.created', 'schedule.task.cancelled', 'app.published', 'app.unpublished', 'connection.pending', 'connection.renamed', 'connection.disconnected']) {
      assert.equal(isCanonicalType(type), true, type);
    }

    assert.equal(isCanonicalType('scheduler.note'), false);
  });

  test('the names of Settings changing is canonical, written by the operator', () => {
    assert.equal(isCanonicalType('settings.updated'), true);
    assert.equal(isCanonicalType('settings.cleared'), false);
    validateEnvelope({ type: 'settings.updated', actor: 'user', userId: 'u', payload: { workspaceName: 'Home', operatorName: null } });
  });

  test('any actor may write them; a thread needs its user', () => {
    validateEnvelope({ type: 'project.created', actor: 'agent', agentName: 'coordinator', userId: 'u', threadId: 'main', payload: {} });
    validateEnvelope({ type: 'app.published', actor: 'user', userId: 'u', payload: {} });
    validateEnvelope({ type: 'schedule.task.cancelled', actor: 'system', userId: 'u', payload: {} });
    assert.throws(() => validateEnvelope({ type: 'project.created', actor: 'agent', userId: 'u', threadId: 'main', payload: {} }), AppendError);
  });

  test('project and app are reserved first segments (no agent may be named so)', () => {
    assert.equal(RESERVED_DOMAINS.has('project'), true);
    assert.equal(RESERVED_DOMAINS.has('app'), true);
    assert.equal(RESERVED_DOMAINS.has('schedule'), true);
    assert.equal(RESERVED_DOMAINS.has('settings'), true);
  });
});
