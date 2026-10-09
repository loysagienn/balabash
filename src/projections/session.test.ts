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

  it('helpers', () => {
    assert.equal(sessionStateFrom({ state: 'act' }), 'act');
    assert.equal(sessionStateFrom({}), null);
    assert.equal(isSessionEvent('session.turn'), true);
    assert.equal(isSessionEvent('thread.started'), false);
  });
});
