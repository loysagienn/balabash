// The retention sweep of SDK sessions (session-cleanup.ts) over the stand's
// database: a finished thread's named sessions are deleted and journaled
// (session.deleted, found or not) once its terminal is older than the
// cutoff; an active thread's and a freshly finished thread's sessions stay;
// a second pass finds nothing; a deletion that throws is retried next time.
//
// Run: npm test  (node:test, native type stripping — no build needed).

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startStand } from '../test-support/stand.ts';
import type { Stand } from '../test-support/stand.ts';
import type { JsonObject } from '../core/contract.ts';
import type { SessionDeleters } from './session-cleanup.ts';

let stand: Stand;
let appendEvent: typeof import('../core/append.ts')['appendEvent'];
let events: typeof import('../core/events.ts');
let cleanup: typeof import('./session-cleanup.ts');

before(async () => {
  stand = await startStand();
  ({ appendEvent } = await import('../core/append.ts'));
  events = await import('../core/events.ts');
  cleanup = await import('./session-cleanup.ts');
});

after(() => stand.stop());

async function startChild(agent: string): Promise<string> {
  const id = randomUUID();

  await appendEvent({ type: 'thread.started', actor: 'system', workspaceId: stand.workspaceId, threadId: id, targetThreadId: stand.mainThreadId, payload: { agent, input: 'go' } });

  return id;
}

async function journal(threadId: string, agent: string, type: string, payload: JsonObject): Promise<void> {
  await appendEvent({ type, actor: 'agent', agentName: agent, workspaceId: stand.workspaceId, threadId, payload });
}

async function finish(threadId: string): Promise<void> {
  await appendEvent({ type: 'thread.cancelled', actor: 'system', workspaceId: stand.workspaceId, threadId, payload: { reason: 'stop' } });
}

// Everything terminal so far is expired; nothing is.
const ALL = () => new Date(Date.now() + 60_000);
const NONE = () => new Date(0);

function recordingDeleters(answer: (sdkSessionId: string) => boolean | Error): SessionDeleters & { calls: string[] } {
  const calls: string[] = [];
  const deleter = async (sdkSessionId: string) => {
    calls.push(sdkSessionId);

    const result = answer(sdkSessionId);

    if (result instanceof Error) {
      throw result;
    }

    return result;
  };

  return { claude: deleter, codex: deleter, calls };
}

describe('sweepExpiredSessions', () => {
  test('deletes and journals every named session of a thread finished before the cutoff; active and fresh threads keep theirs; a second pass is empty', async () => {
    const done = await startChild('engineer');
    const active = await startChild('manager');
    const codexDone = await startChild('codex');

    await journal(done, 'engineer', 'session.sdk', { sdk: 'claude', sdkSessionId: 'c-old' });
    await journal(done, 'engineer', 'session.sdk', { sdk: 'claude', sdkSessionId: 'c-new' });
    await journal(active, 'manager', 'session.sdk', { sdk: 'claude', sdkSessionId: 'c-active' });
    await journal(codexDone, 'codex', 'session.sdk', { sdk: 'codex', sdkSessionId: 'x-done' });
    await finish(done);
    await finish(codexDone);

    assert.deepEqual(await cleanup.listExpiredSessions(NONE()), []);

    const expired = await cleanup.listExpiredSessions(ALL());

    assert.deepEqual(
      expired.map(e => [e.threadId, e.sdk, e.sdkSessionId]).sort(),
      [[done, 'claude', 'c-new'], [done, 'claude', 'c-old'], [codexDone, 'codex', 'x-done']].sort(),
    );

    const deleters = recordingDeleters(id => id !== 'c-old');
    const result = await cleanup.sweepExpiredSessions(ALL(), deleters);

    assert.deepEqual(result, { deleted: 2, missing: 1, failed: 0 });
    assert.deepEqual(deleters.calls.sort(), ['c-new', 'c-old', 'x-done']);

    const journaled = (await events.listThreadEvents(done)).filter(event => event.type === 'session.deleted').map(event => event.payload);

    assert.deepEqual(
      journaled.sort((a, b) => String(a.sdkSessionId).localeCompare(String(b.sdkSessionId))),
      [
        { sdk: 'claude', sdkSessionId: 'c-new', found: true },
        { sdk: 'claude', sdkSessionId: 'c-old', found: false },
      ],
    );
    assert.deepEqual((await events.getLastThreadEvent(codexDone, 'session.deleted'))?.payload, { sdk: 'codex', sdkSessionId: 'x-done', found: true });
    assert.equal(await events.getLastThreadEvent(active, 'session.deleted'), null);

    const again = recordingDeleters(() => true);

    assert.deepEqual(await cleanup.sweepExpiredSessions(ALL(), again), { deleted: 0, missing: 0, failed: 0 });
    assert.deepEqual(again.calls, []);
  });

  test('a deletion that throws is counted as failed, not journaled, and tried again at the next pass', async () => {
    const done = await startChild('engineer');

    await journal(done, 'engineer', 'session.sdk', { sdk: 'claude', sdkSessionId: 'c-stuck' });
    await finish(done);

    const failing = recordingDeleters(() => new Error('disk on fire'));

    assert.deepEqual(await cleanup.sweepExpiredSessions(ALL(), failing), { deleted: 0, missing: 0, failed: 1 });
    assert.equal(await events.getLastThreadEvent(done, 'session.deleted'), null);

    const working = recordingDeleters(() => true);

    assert.deepEqual(await cleanup.sweepExpiredSessions(ALL(), working), { deleted: 1, missing: 0, failed: 0 });
    assert.deepEqual(working.calls, ['c-stuck']);
  });

  test('retentionCutoff is N days before now', () => {
    const now = new Date('2026-11-09T12:00:00Z');

    assert.equal(cleanup.retentionCutoff(now, 7).toISOString(), '2026-11-02T12:00:00.000Z');
  });
});
