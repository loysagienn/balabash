// Threads survive an app restart (resume-runs.ts) over the stand's database:
// the saved session of a thread is the newest session.sdk its journal wrote,
// interrupted when its last session.state is `run`; the boot sweep cancels
// only the run threads without a saved session (and, by the cascade, their
// subtrees); the resume gives a surviving thread its run back and journals
// session.resumed — a thread whose agent the catalog does not know fails the
// ordinary way.
//
// Run: npm test  (node:test, native type stripping — no build needed).

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startStand } from '../test-support/stand.ts';
import type { Stand } from '../test-support/stand.ts';
import type { JsonObject } from '../core/contract.ts';

let stand: Stand;
let appendEvent: typeof import('../core/append.ts')['appendEvent'];
let threads: typeof import('../core/threads.ts');
let events: typeof import('../core/events.ts');
let resume: typeof import('./resume-runs.ts');
let runs: typeof import('../runtime/runs.ts');

before(async () => {
  stand = await startStand();
  ({ appendEvent } = await import('../core/append.ts'));
  threads = await import('../core/threads.ts');
  events = await import('../core/events.ts');
  resume = await import('./resume-runs.ts');
  runs = await import('../runtime/runs.ts');
});

after(() => stand.stop());

async function startChild(agent: string, parent: string = stand.mainThreadId): Promise<string> {
  const id = randomUUID();

  await appendEvent({ type: 'thread.started', actor: 'system', workspaceId: stand.workspaceId, threadId: id, targetThreadId: parent, payload: { agent, input: 'go' } });

  return id;
}

async function journal(threadId: string, agent: string, type: string, payload: JsonObject): Promise<void> {
  await appendEvent({ type, actor: 'agent', agentName: agent, workspaceId: stand.workspaceId, threadId, payload });
}

describe('savedSessionOf', () => {
  test('null without a named session; the newest session.sdk otherwise, interrupted by a last session.state run', async () => {
    const thread = await startChild('engineer');

    assert.equal(await resume.savedSessionOf(thread), null);

    await journal(thread, 'engineer', 'session.sdk', { sdk: 'claude', sdkSessionId: 'old' });
    await journal(thread, 'engineer', 'session.sdk', { sdk: 'claude', sdkSessionId: 'new' });
    await journal(thread, 'engineer', 'session.state', { state: 'run' });
    await journal(thread, 'engineer', 'session.state', { state: 'wait' });

    assert.deepEqual(await resume.savedSessionOf(thread), { sdkSessionId: 'new', interrupted: false });

    await journal(thread, 'engineer', 'session.state', { state: 'run' });

    assert.deepEqual(await resume.savedSessionOf(thread), { sdkSessionId: 'new', interrupted: true });
  });
});

describe('the boot sweep and the resume', () => {
  test('cancel only the run threads without a saved session; the cascade takes a saved child of an unsaved parent', async () => {
    const saved = await startChild('engineer');
    const unsaved = await startChild('manager');
    const savedChildOfUnsaved = await startChild('browser', unsaved);

    await journal(saved, 'engineer', 'session.sdk', { sdk: 'claude', sdkSessionId: 's1' });
    await journal(savedChildOfUnsaved, 'browser', 'session.sdk', { sdk: 'claude', sdkSessionId: 's2' });

    await resume.tombstoneUnresumableThreads();

    assert.equal((await threads.getThread(saved))?.status, 'active');
    assert.equal((await threads.getThread(unsaved))?.status, 'cancelled');
    assert.equal((await threads.getThread(savedChildOfUnsaved))?.status, 'cancelled');
    assert.equal((await events.getLastThreadEvent(unsaved, 'thread.cancelled'))?.payload.reason, 'process_restart');

    // The forced restart's sweep (no spare) still takes everything.
    await threads.tombstoneActiveThreads('restart_requested');
    assert.equal((await threads.getThread(saved))?.status, 'cancelled');
  });

  test('a surviving thread whose agent the catalog does not know is journaled as resumed and then fails the ordinary way', async () => {
    const thread = await startChild('no_such_agent');

    await journal(thread, 'no_such_agent', 'session.sdk', { sdk: 'claude', sdkSessionId: 's3' });

    const result = await resume.resumeThreadRuns();

    assert.ok(result.failed >= 1);
    assert.deepEqual((await events.getLastThreadEvent(thread, 'session.resumed'))?.payload, { sdkSessionId: 's3', interrupted: false });
    assert.equal((await threads.getThread(thread))?.status, 'failed');
    assert.equal(runs.getRun(thread), null);
  });

  test('listActiveChildIds names the active children only', async () => {
    const parent = await startChild('manager');
    const active = await startChild('browser', parent);
    const done = await startChild('browser', parent);

    await appendEvent({ type: 'thread.cancelled', actor: 'system', workspaceId: stand.workspaceId, threadId: done, payload: { reason: 'stop' } });

    assert.deepEqual(await threads.listActiveChildIds(parent), [active]);
  });
});
