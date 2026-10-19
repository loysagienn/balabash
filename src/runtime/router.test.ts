// The thread router over the stand (src/test-support/stand.ts) with fake
// hooks: a child's thread.started spawns through the hook; a delivered
// event rises the run lazily when the hook allows — and so does
// thread.interrupt, which after a restart finds no run in memory for a
// remote thread and must still reach its facade; a routed terminal aborts
// and drops the run.
//
// Run: npm test  (node:test, native type stripping — no build needed).

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startStand } from '../test-support/stand.ts';
import type { Stand } from '../test-support/stand.ts';
import type { Event, Thread } from '../core/contract.ts';
import type { Consumer } from '../core/consumers.ts';

let stand: Stand;
let appendEvent: typeof import('../core/append.ts')['appendEvent'];
let startThreadRouter: typeof import('./router.ts')['startThreadRouter'];
let runs: typeof import('./runs.ts');

const log: string[] = [];
const accepted = new Map<string, Event[]>();
let consumer: Consumer | null = null;

function fakeRun(threadId: string) {
  return {
    accept: (event: Event) => {
      accepted.set(threadId, [...(accepted.get(threadId) ?? []), event]);
    },
    interrupt: () => {
      log.push(`interrupt ${threadId}`);
    },
    abort: (reason: string) => {
      log.push(`abort ${threadId} ${reason}`);
    },
  };
}

before(async () => {
  stand = await startStand();
  ({ appendEvent } = await import('../core/append.ts'));
  ({ startThreadRouter } = await import('./router.ts'));
  runs = await import('./runs.ts');

  consumer = startThreadRouter({
    // Only remote threads rise lazily here (the coordinator's rise is the
    // app's); the hook is what the app installs for them — a facade.
    createRun: (thread: Thread) => {
      log.push(`rise ${thread.id}`);

      return thread.remote ? fakeRun(thread.id) : null;
    },
    spawnRun: async (thread: Thread) => {
      log.push(`spawn ${thread.id} remote=${thread.remote}`);

      return fakeRun(thread.id);
    },
  });
});

after(async () => {
  consumer?.stop();
  await stand.stop();
});

async function until(condition: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (!condition()) {
    if (Date.now() > deadline) {
      assert.fail(`timed out waiting for ${what}`);
    }

    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

async function startChild(policy: Record<string, unknown>): Promise<string> {
  const id = randomUUID();

  await appendEvent({ type: 'thread.started', actor: 'system', workspaceId: stand.workspaceId, threadId: id, targetThreadId: stand.mainThreadId, payload: { agent: 'fake_agent', title: 'x', ...policy } });

  return id;
}

describe('the thread router', () => {
  test('spawns the run of a started child through the hook, with the thread’s remote fact', async () => {
    const remote = await startChild({ remote: true });
    const local = await startChild({});

    await until(() => log.includes(`spawn ${remote} remote=true`) && log.includes(`spawn ${local} remote=false`), 'both spawns');
    assert.ok(runs.getRun(remote));
    assert.ok(runs.getRun(local));
  });

  test('a delivered event and a soft stop both rise the run lazily when the hook allows', async () => {
    const remote = await startChild({ remote: true });

    await until(() => Boolean(runs.getRun(remote)), 'the spawn');
    // The process restarted: no run in memory.
    runs.dropRun(remote);

    await appendEvent({ type: 'thread.interrupt', actor: 'user', workspaceId: stand.workspaceId, threadId: stand.mainThreadId, targetThreadId: remote, payload: { reason: 'stop' } });
    await until(() => log.includes(`interrupt ${remote}`), 'the interrupt');
    assert.ok(log.includes(`rise ${remote}`));
    assert.ok(runs.getRun(remote));

    runs.dropRun(remote);
    await appendEvent({ type: 'user.message', actor: 'user', workspaceId: stand.workspaceId, threadId: remote, payload: { text: 'hello' } });
    await until(() => (accepted.get(remote) ?? []).some(event => event.type === 'user.message'), 'the message');
    assert.ok(runs.getRun(remote));
  });

  test('a thread without a risable run drops the delivered event and the stop', async () => {
    const local = await startChild({});

    await until(() => Boolean(runs.getRun(local)), 'the spawn');
    runs.dropRun(local);
    log.length = 0;

    await appendEvent({ type: 'thread.interrupt', actor: 'user', workspaceId: stand.workspaceId, threadId: stand.mainThreadId, targetThreadId: local, payload: { reason: 'stop' } });
    const marker = await startChild({ remote: true });

    await until(() => log.includes(`spawn ${marker} remote=true`), 'the marker spawn after the stop');
    assert.ok(log.includes(`rise ${local}`));
    assert.ok(!log.includes(`interrupt ${local}`));
    assert.equal(runs.getRun(local), null);
  });

  test('a routed terminal aborts and drops the run', async () => {
    const remote = await startChild({ remote: true });

    await until(() => Boolean(runs.getRun(remote)), 'the spawn');
    await appendEvent({ type: 'thread.cancelled', actor: 'system', workspaceId: stand.workspaceId, threadId: remote, payload: { reason: 'done' } });
    await until(() => log.includes(`abort ${remote} thread.cancelled`), 'the abort');
    assert.equal(runs.getRun(remote), null);
  });
});
