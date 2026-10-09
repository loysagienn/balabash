import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Event } from '../core/contract.ts';
import { groupActions, pairToolCalls } from './tool-calls.ts';

function event(seq: number, type: string, payload: Event['payload'], at: string): Event {
  return {
    seq: BigInt(seq),
    id: `e${seq}`,
    type,
    actor: 'agent',
    agentName: 'engineer',
    userId: 'u',
    threadId: 't',
    targetThreadId: null,
    payload,
    schemaVersion: 1,
    createdAt: new Date(at),
  };
}

describe('pairToolCalls', () => {
  it('folds started + completed into one done call with a duration', () => {
    const calls = pairToolCalls([
      event(1, 'tool.call.started', { callId: 'c1', functionName: 'http_get', input: { url: 'x' } }, '2026-10-08T10:00:00Z'),
      event(2, 'thread.progress', { text: 'noise' }, '2026-10-08T10:00:01Z'),
      event(3, 'tool.call.completed', { callId: 'c1', functionName: 'http_get', serverName: 'http', toolName: 'get', result: { content: [] } }, '2026-10-08T10:00:02.500Z'),
    ]);

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.status, 'done');
    assert.equal(calls[0]!.durationMs, 2500);
    assert.equal(calls[0]!.serverName, 'http');
    assert.deepEqual(calls[0]!.input, { url: 'x' });
    assert.equal(calls[0]!.startedSeq, 1n);
    assert.equal(calls[0]!.endedSeq, 3n);
  });

  it('keeps a running call open and marks a failed one', () => {
    const calls = pairToolCalls([
      event(1, 'tool.call.started', { callId: 'a', functionName: 'f', input: {} }, '2026-10-08T10:00:00Z'),
      event(2, 'tool.call.started', { callId: 'b', functionName: 'g', input: {} }, '2026-10-08T10:00:01Z'),
      event(3, 'tool.call.failed', { callId: 'b', functionName: 'g', error: 'boom' }, '2026-10-08T10:00:02Z'),
    ]);

    assert.deepEqual(
      calls.map(call => [call.callId, call.status, call.durationMs, call.error]),
      [
        ['a', 'run', null, null],
        ['b', 'err', 1000, 'boom'],
      ],
    );
  });

  it('tolerates an outcome without its start and duplicate events', () => {
    const completed = event(5, 'tool.call.completed', { callId: 'z', functionName: 'f', serverName: 's', toolName: 't', result: {} }, '2026-10-08T10:00:00Z');
    const calls = pairToolCalls([completed, completed]);

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.status, 'done');
    assert.equal(calls[0]!.startedAt, null);
    assert.equal(calls[0]!.durationMs, null);
  });
});

describe('groupActions', () => {
  it('runs consecutive actions together and passes the rest through', () => {
    const grouped = groupActions(['a1', 'a2', 'm', 'a3', 'm2', 'm3'], item => item.startsWith('a'));

    assert.deepEqual(grouped, [
      { kind: 'group', items: ['a1', 'a2'] },
      { kind: 'single', item: 'm' },
      { kind: 'group', items: ['a3'] },
      { kind: 'single', item: 'm2' },
      { kind: 'single', item: 'm3' },
    ]);
  });
});
