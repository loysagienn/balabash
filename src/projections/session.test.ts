import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { foldSession, isSessionEvent, sessionStateFrom } from './session.ts';

describe('foldSession', () => {
  it('builds the view from state and context events, keeping the reference when nothing changes', () => {
    const run = foldSession(null, 'session.state', { state: 'run' });

    assert.deepEqual(run, { state: 'run', context: null });
    assert.equal(foldSession(run, 'session.state', { state: 'run' }), run);
    assert.equal(foldSession(run, 'session.tool.started', { toolUseId: 't', name: 'Bash', input: {} }), run);
    assert.equal(foldSession(run, 'session.state', { state: 'sleeping' }), run);

    const measured = foldSession(run, 'session.context', { totalTokens: 48_659, maxTokens: 1_000_000, percentage: 5 });

    assert.deepEqual(measured, { state: 'run', context: { used: 48_659, max: 1_000_000 } });
    assert.equal(foldSession(measured, 'session.context', { totalTokens: 'x' }), measured);

    const waiting = foldSession(measured, 'session.state', { state: 'wait' });

    assert.deepEqual(waiting, { state: 'wait', context: { used: 48_659, max: 1_000_000 } });
  });

  it('a context measured before any state starts the view as waiting', () => {
    assert.deepEqual(foldSession(null, 'session.context', { totalTokens: 10, maxTokens: 100, percentage: 10 }), {
      state: 'wait',
      context: { used: 10, max: 100 },
    });
  });

  it('a terminal of the thread drops the session', () => {
    const view = foldSession(null, 'session.state', { state: 'run' });

    assert.equal(foldSession(view, 'thread.completed', { summary: { text: 'done' } }), null);
    assert.equal(foldSession(view, 'thread.failed', { error: 'boom' }), null);
    assert.equal(foldSession(null, 'thread.cancelled', { reason: 'x' }), null);
  });

  it('keeps the model and effort of the newest session.started through state and context', () => {
    const started = foldSession(null, 'session.started', { model: 'claude-opus-5-5', effort: 'high', tools: [], mcpServers: [] });

    assert.deepEqual(started, { state: 'wait', context: null, started: { model: 'claude-opus-5-5', effort: 'high' } });
    assert.equal(foldSession(started, 'session.started', { model: 'claude-opus-5-5', effort: 'high' }), started);
    // No model named: nothing to keep.
    assert.equal(foldSession(started, 'session.started', { tools: [] }), started);

    const running = foldSession(foldSession(started, 'session.state', { state: 'run' }), 'session.context', { totalTokens: 5, maxTokens: 50 });

    assert.deepEqual(running, { state: 'run', context: { used: 5, max: 50 }, started: { model: 'claude-opus-5-5', effort: 'high' } });
    // A resumed session on another model, without effort.
    assert.deepEqual(foldSession(running, 'session.started', { model: 'gpt-5.6', effort: null }), { state: 'run', context: { used: 5, max: 50 }, started: { model: 'gpt-5.6', effort: null } });
  });

  it('moves the session to the model of a session-scope fallback and keeps the first model it left; a local fallback changes nothing', () => {
    const started = foldSession(null, 'session.started', { model: 'claude-fable-5-1', effort: 'high', tools: [], mcpServers: [] });
    const fallen = foldSession(started, 'session.fallback', { from: 'claude-fable-5-1', to: 'claude-opus-4-8', scope: 'session', source: 'refusal', category: 'cyber' });

    assert.deepEqual(fallen, { state: 'wait', context: null, started: { model: 'claude-opus-4-8', effort: 'high', fallback: { from: 'claude-fable-5-1', category: 'cyber' } } });
    assert.equal(foldSession(fallen, 'session.fallback', { from: 'claude-fable-5-1', to: 'claude-opus-4-8', scope: 'session', source: 'observed' }), fallen);
    assert.equal(foldSession(fallen, 'session.fallback', { from: 'claude-opus-4-8', to: 'claude-haiku-4-5', scope: 'local', source: 'refusal', category: 'cyber' }), fallen);
    // A second hop keeps the model the session started on.
    assert.deepEqual(foldSession(fallen, 'session.fallback', { from: 'claude-opus-4-8', to: 'claude-opus-5', scope: 'session', source: 'observed' })?.started, {
      model: 'claude-opus-5',
      effort: 'high',
      fallback: { from: 'claude-fable-5-1', category: 'cyber' },
    });
    // A new start is a new session: no fallback.
    assert.deepEqual(foldSession(fallen, 'session.started', { model: 'claude-fable-5-1', effort: 'high' })?.started, { model: 'claude-fable-5-1', effort: 'high' });
    // A fallback before any start names the model the session runs on now.
    assert.deepEqual(foldSession(null, 'session.fallback', { from: 'claude-fable-5-1', to: 'claude-opus-4-8', scope: 'session', source: 'observed' }), {
      state: 'wait',
      context: null,
      started: { model: 'claude-opus-4-8', effort: null, fallback: { from: 'claude-fable-5-1', category: null } },
    });
    assert.equal(foldSession(started, 'session.fallback', { from: 'claude-fable-5-1', scope: 'session' }), started);
  });

  it('keeps a remote session’s link (remoteLink of session.started); a local session has none', () => {
    const remote = foldSession(null, 'session.started', { model: 'ext', effort: null, tools: [], mcpServers: [], remoteLink: 'https://ext/chat/s1' });

    assert.deepEqual(remote, { state: 'wait', context: null, started: { model: 'ext', effort: null, remoteLink: 'https://ext/chat/s1' } });
    assert.equal(foldSession(remote, 'session.started', { model: 'ext', effort: null, remoteLink: 'https://ext/chat/s1' }), remote);
    assert.equal(foldSession(null, 'session.started', { model: 'ext', remoteLink: '' })?.started?.remoteLink, undefined);
  });

  it('helpers', () => {
    assert.equal(sessionStateFrom({ state: 'act' }), 'act');
    assert.equal(sessionStateFrom({}), null);
    assert.equal(isSessionEvent('session.turn'), true);
    assert.equal(isSessionEvent('thread.started'), false);
  });
});
