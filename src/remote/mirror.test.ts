// The mirror as a pure function: one read of the driver → the events of
// the thread and the next watch state. The owner decides the surface (an
// agent.message to the user, a thread.message to the parent); our own
// prompt's echo is skipped; an ask opens the act state and is resolved
// once, whoever resolved it; the closing summary's turn completes the
// thread instead of replying.
//
// Run: npm test  (node:test, native type stripping — no build needed).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { RemoteRead } from '../core/contract.ts';
import { mirrorRead } from './mirror.ts';
import type { MirrorContext } from './mirror.ts';
import { initialWatch } from './store.ts';

function ctx(partial: Partial<MirrorContext> = {}, watch: Partial<ReturnType<typeof initialWatch>> = {}): MirrorContext {
  return {
    threadId: 't1',
    workspaceId: 'u1',
    kind: 'fake_agent',
    watch: initialWatch({ headless: false, parentId: 'main', notification: 'urgent', ownMessageIds: ['m-own'], ...watch }),
    ...partial,
  };
}

const read = (items: RemoteRead['items'], phase: RemoteRead['phase'] = 'idle', extra: Partial<RemoteRead> = {}): RemoteRead => ({ cursor: 'c2', phase, items, ...extra });

describe('mirrorRead', () => {
  test('a turn of an ordinary thread: our echo skipped, the text to the user, the tools journaled, the state after the turn', () => {
    const result = mirrorRead(
      read([
        { kind: 'turn.started', turnId: 'turn-1', messageId: 'm-own' },
        { kind: 'prompt', messageId: 'm-own', text: 'do x' },
        { kind: 'tool.started', turnId: 'turn-1', callId: 'c1', name: 'bash', input: { cmd: 'ls' } },
        { kind: 'tool.finished', turnId: 'turn-1', callId: 'c1', name: 'bash', output: 'a b', isError: false },
        { kind: 'text', turnId: 'turn-1', text: 'done' },
        { kind: 'turn.finished', turnId: 'turn-1', outcome: 'completed', text: 'done' },
      ]),
      ctx(),
    );

    assert.deepEqual(
      result.events.map(event => [event.type, event.actor, event.agentName]),
      [
        ['tool.call.started', 'agent', 'fake_agent'],
        ['tool.call.completed', 'agent', 'fake_agent'],
        ['agent.message', 'agent', 'fake_agent'],
      ],
    );
    assert.deepEqual(result.events[2].payload, { content: [{ type: 'text', text: 'done' }] });
    assert.deepEqual((result.events[1].payload as { result: unknown }).result, { content: [{ type: 'text', text: 'a b' }] });
    assert.equal(result.phase, 'idle');
    assert.equal(result.activity, true);
    assert.equal(result.finished, null);
    assert.equal(result.watch.lastTurnText, 'done');
  });

  test('a headless thread tells its parent; a foreign reply is a user.message from the other side', () => {
    const result = mirrorRead(
      read([
        { kind: 'prompt', messageId: 'm-foreign', author: 'alice', text: 'please also y' },
        { kind: 'text', turnId: 'turn-2', text: 'ok' },
        { kind: 'artifact', title: 'demo', uri: 'https://demo.apps' },
      ]),
      ctx({}, { headless: true }),
    );

    assert.deepEqual(
      result.events.map(event => [event.type, event.actor, event.targetThreadId ?? null, event.payload]),
      [
        ['user.message', 'user', null, { text: 'please also y', source: 'remote', identity: { username: 'alice' } }],
        ['thread.message', 'agent', 'main', { text: 'ok' }],
        ['thread.message', 'agent', 'main', { text: 'demo: https://demo.apps' }],
      ],
    );
  });

  test('an ask opens act and is resolved once: by the driver, or already from Balabash', () => {
    const opened = mirrorRead(
      read([{ kind: 'ask.opened', askId: 'a1', askKind: 'approval', text: 'POST /issues', link: 'https://x', options: ['allow', 'deny'] }], 'asking'),
      ctx(),
    );

    assert.deepEqual(
      opened.events.map(event => [event.type, event.payload]),
      [
        ['agent.ask', { askId: 'a1', kind: 'approval', text: 'POST /issues', link: 'https://x', options: ['allow', 'deny'] }],
        ['thread.notification', { level: 'urgent', text: 'Needs your decision: POST /issues — https://x' }],
      ],
    );
    assert.equal(opened.phase, 'asking');
    assert.deepEqual(opened.watch.openAsks, [{ askId: 'a1', kind: 'approval', options: ['allow', 'deny'] }]);

    // The same ask again: nothing; idle with it still open stays asking.
    const again = mirrorRead(read([{ kind: 'ask.opened', askId: 'a1', askKind: 'approval', text: 'POST /issues', options: ['allow', 'deny'] }]), ctx({ watch: opened.watch }));

    assert.deepEqual(again.events, []);
    assert.equal(again.phase, 'asking');

    const closedByDriver = mirrorRead(read([{ kind: 'ask.closed', askId: 'a1', outcome: 'denied' }]), ctx({ watch: opened.watch }));

    assert.deepEqual(closedByDriver.events.map(event => [event.type, event.payload]), [['agent.ask.resolved', { askId: 'a1', outcome: 'denied' }]]);
    assert.equal(closedByDriver.phase, 'idle');

    const closedAfterOurs = mirrorRead(read([{ kind: 'ask.closed', askId: 'a1', outcome: 'approved_once' }]), ctx({ watch: { ...opened.watch, resolvedAsks: ['a1'] } }));

    assert.deepEqual(closedAfterOurs.events, []);
    assert.deepEqual(closedAfterOurs.watch.resolvedAsks, []);
  });

  test('errors and failed turns notify once; the notification level is clamped by the thread’s policy', () => {
    const result = mirrorRead(
      read([
        { kind: 'turn.started', turnId: 'turn-3' },
        { kind: 'error', text: 'usage limit', terminal: true },
        { kind: 'turn.finished', turnId: 'turn-3', outcome: 'failed', text: '' },
        { kind: 'turn.started', turnId: 'turn-4' },
        { kind: 'turn.finished', turnId: 'turn-4', outcome: 'failed', text: '' },
      ]),
      ctx({}, { notification: 'normal' }),
    );

    assert.deepEqual(
      result.events.map(event => event.payload),
      [
        { level: 'normal', text: 'The turn failed: usage limit' },
        { level: 'normal', text: 'The turn ended with an error.' },
      ],
    );
  });

  test('a failed turn of a headless thread is told to the parent, who is waiting for a reply; a non-terminal error is a notification alone', () => {
    const result = mirrorRead(
      read([
        { kind: 'turn.started', turnId: 'turn-3' },
        { kind: 'error', text: 'rate limited, retrying', terminal: false },
        { kind: 'error', text: 'usage limit', terminal: true },
        { kind: 'turn.finished', turnId: 'turn-3', outcome: 'failed', text: '' },
        { kind: 'turn.started', turnId: 'turn-4' },
        { kind: 'turn.finished', turnId: 'turn-4', outcome: 'failed', text: '' },
      ]),
      ctx({}, { headless: true, parentId: 'parent-1' }),
    );

    assert.deepEqual(
      result.events.map(event => [event.type, event.targetThreadId ?? null, event.payload]),
      [
        ['thread.notification', null, { level: 'normal', text: 'rate limited, retrying' }],
        ['thread.notification', null, { level: 'urgent', text: 'The turn failed: usage limit' }],
        ['thread.message', 'parent-1', { text: '[The turn failed — the session stays open and waits for your next message] usage limit' }],
        ['thread.notification', null, { level: 'normal', text: 'The turn ended with an error.' }],
        ['thread.message', 'parent-1', { text: '[The turn failed — the session stays open and waits for your next message] The turn ended with an error.' }],
      ],
    );
    assert.equal(result.phase, 'idle');
  });

  test('the closing summary’s turn finishes the thread with its text and is not told as a reply', () => {
    const asked = ctx({}, { finish: { messageId: 'm-fin', turnId: null, startedAt: '2026-10-13T00:00:00Z' }, ownMessageIds: ['m-fin'] });
    const result = mirrorRead(
      read([
        { kind: 'turn.started', turnId: 'turn-9', messageId: 'm-fin' },
        { kind: 'prompt', messageId: 'm-fin', text: 'summary please' },
        { kind: 'text', turnId: 'turn-9', text: 'Did x; y remains.' },
        { kind: 'turn.finished', turnId: 'turn-9', outcome: 'completed', text: 'Did x; y remains.' },
      ]),
      asked,
    );

    assert.deepEqual(result.events, []);
    assert.deepEqual(result.finished, { text: 'Did x; y remains.' });
    assert.equal(result.watch.finish?.turnId, 'turn-9');
  });

  test('the summary outstanding keeps the phase finishing over an idle read; a driver naming no prompt — the first turn after the ask is the summary’s', () => {
    const asked = ctx({}, { finish: { messageId: 'm-fin', turnId: null, startedAt: '2026-10-13T00:00:00Z' }, ownMessageIds: ['m-fin'] });
    const idle = mirrorRead(read([], 'idle'), asked);

    assert.equal(idle.phase, 'finishing');
    assert.ok(idle.watch.finish);

    const foreign = mirrorRead(read([{ kind: 'turn.started', turnId: 'turn-a', messageId: 'm-other' }, { kind: 'text', turnId: 'turn-a', text: 'someone else’s turn' }, { kind: 'turn.finished', turnId: 'turn-a', outcome: 'completed', text: 'someone else’s turn' }], 'idle'), asked);

    assert.equal(foreign.finished, null);
    assert.equal(foreign.watch.finish?.turnId, null);
    assert.equal(foreign.phase, 'finishing');
    assert.deepEqual(foreign.events.map(event => event.type), ['agent.message']);

    const nameless = mirrorRead(read([{ kind: 'turn.started', turnId: 'turn-b' }, { kind: 'text', turnId: 'turn-b', text: 'All done.' }, { kind: 'turn.finished', turnId: 'turn-b', outcome: 'completed', text: 'All done.' }], 'idle'), asked);

    assert.deepEqual(nameless.finished, { text: 'All done.' });
    assert.deepEqual(nameless.events, []);
  });

  test('a lost session is gone; a resync is noted silently; nothing read is no activity', () => {
    assert.equal(mirrorRead(read([], 'gone'), ctx()).phase, 'gone');

    const resynced = mirrorRead(read([], 'idle', { resynced: true }), ctx());

    assert.deepEqual(resynced.events.map(event => event.payload), [{ level: 'silent', text: 'The mirror was resynchronised with the session.' }]);
    assert.equal(resynced.activity, false);
  });
});
