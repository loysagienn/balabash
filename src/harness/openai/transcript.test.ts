// The coordinator's transcript: its own one-hop commands (finish, pause,
// decide — like cancel) render with the child they address, so the model
// sees which thread it already asked and waits instead of asking again.
//
// Run: npm test  (node:test, native type stripping — no build needed).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildTranscript } from './transcript.ts';

const at = '2026-10-14T12:00:00.000Z';

describe('buildTranscript — the one-hop commands', () => {
  test('finish, pause and decide name the child thread they address', () => {
    const { text } = buildTranscript([
      { seq: 1, type: 'thread.finish', actor: 'agent', agentName: 'coordinator', threadId: 'main', targetThreadId: 'child-1', payload: { reason: 'finished_by_coordinator' }, createdAt: at },
      { seq: 2, type: 'thread.pause', actor: 'user', agentName: null, threadId: 'main', targetThreadId: 'child-2', payload: { identity: { username: 'operator' }, source: 'web' }, createdAt: at },
      { seq: 3, type: 'thread.decide', actor: 'user', agentName: null, threadId: 'main', targetThreadId: 'child-3', payload: { askId: 'a1', decision: 'allow', source: 'web' }, createdAt: at },
    ]);
    // The time markers are the transcript's own; the commands are what is asked.
    const lines = text
      .split('\n')
      .filter(line => line.startsWith('{'))
      .map(line => JSON.parse(line) as Record<string, unknown>)
      .filter(line => line.type !== 'system.time');

    assert.deepEqual(
      lines.map(line => [line.type, line.targetThreadId, line.reason ?? null, line.askId ?? null, line.decision ?? null]),
      [
        ['thread.finish', 'child-1', 'finished_by_coordinator', null, null],
        ['thread.pause', 'child-2', null, null, null],
        ['thread.decide', 'child-3', null, 'a1', 'allow'],
      ],
    );
  });
});
