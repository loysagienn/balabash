// The session runner's opening move: a fresh run opens its SDK session with
// the spawn prompt at once; a run resumed after an app restart opens the
// saved session (`resume`) — at once with the cut-off note when a turn was
// in flight, otherwise only when the first message arrives, the idle note in
// front of it; a dormant resumed run cancelled before anything woke it never
// opens a session.
//
// Run: npm test  (node:test, native type stripping — no build needed).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SESSION_RESUMED_IDLE_NOTE, SESSION_RESUMED_INTERRUPTED_NOTE } from '../../agents/world/index.ts';
import type { AgentDeclaration, AgentSdkSession, Event, RunContext, RunResume, SdkSessionOptions, SdkTurn } from '../core/contract.ts';
import { createSessionRun } from './session-run.ts';

const declaration = { name: 'probe', description: 'probe', sdk: 'claude', tools: [], headless: true } as unknown as AgentDeclaration;
const spec = { instructions: 'You are a probe.' };

type Probe = { ctx: RunContext; opened: SdkSessionOptions[]; pushed: string[]; abort: () => void };

function probe(resume?: RunResume): Probe {
  const opened: SdkSessionOptions[] = [];
  const pushed: string[] = [];
  const controller = new AbortController();

  const session = (): AgentSdkSession => {
    let close: () => void = () => {};
    const closed = new Promise<void>(resolve => {
      close = resolve;
    });

    return {
      push: text => {
        pushed.push(text);
      },
      turns: (async function* (): AsyncGenerator<SdkTurn> {
        await closed;
      })(),
      syncTools: async () => {},
      close: () => close(),
    };
  };

  const ctx = {
    threadId: 'thread-1',
    workspaceId: 'workspace-1',
    signal: controller.signal,
    harness: {
      sdkSession: (options: SdkSessionOptions) => {
        opened.push(options);

        return session();
      },
    },
    stateDir: '/tmp',
    ...(resume ? { resume } : {}),
  } as unknown as RunContext;

  return { ctx, opened, pushed, abort: () => controller.abort() };
}

const message = (text: string): Event =>
  ({ seq: 1n, type: 'user.message', actor: 'user', workspaceId: 'workspace-1', threadId: 'thread-1', payload: { text } }) as unknown as Event;

const tick = () => new Promise(resolve => setTimeout(resolve, 20));

describe('createSessionRun opening', () => {
  test('a fresh run opens with the spawn prompt at once, no resume', async () => {
    const { ctx, opened, abort } = probe();

    createSessionRun(declaration, spec, 'Do the task', ctx);
    await tick();

    assert.equal(opened.length, 1);
    assert.equal(opened[0].initialMessage, 'Do the task');
    assert.equal(opened[0].resume, undefined);
    abort();
  });

  test('a resumed run whose turn was cut off opens the saved session at once with the cut-off note', async () => {
    const { ctx, opened, abort } = probe({ sdkSessionId: 'sdk-1', interrupted: true, childThreadIds: [] });

    createSessionRun(declaration, spec, 'Do the task', ctx);
    await tick();

    assert.equal(opened.length, 1);
    assert.equal(opened[0].resume, 'sdk-1');
    assert.equal(opened[0].initialMessage, SESSION_RESUMED_INTERRUPTED_NOTE);
    abort();
  });

  test('a resumed idle run stays dormant until a message, which opens the session behind the idle note', async () => {
    const { ctx, opened, pushed, abort } = probe({ sdkSessionId: 'sdk-2', interrupted: false, childThreadIds: [] });
    const run = createSessionRun(declaration, spec, 'Do the task', ctx);

    await tick();
    assert.equal(opened.length, 0);

    run.accept(message('Next step, please'));
    await tick();

    assert.equal(opened.length, 1);
    assert.equal(opened[0].resume, 'sdk-2');
    assert.ok(opened[0].initialMessage.startsWith(SESSION_RESUMED_IDLE_NOTE));
    assert.ok(opened[0].initialMessage.endsWith('Next step, please'));

    // Later messages go into the open session as usual.
    run.accept(message('And another'));
    await tick();
    assert.deepEqual(pushed, ['And another']);
    abort();
  });

  test('a resumed run labels the replies of its children it was told about', async () => {
    const { ctx, opened, abort } = probe({ sdkSessionId: 'sdk-3', interrupted: false, childThreadIds: ['child-1'] });
    const run = createSessionRun(declaration, spec, 'Do the task', ctx);

    run.accept({
      seq: 2n,
      type: 'thread.message',
      actor: 'agent',
      workspaceId: 'workspace-1',
      threadId: 'child-1',
      targetThreadId: 'thread-1',
      payload: { text: 'Done on my side' },
    } as unknown as Event);
    await tick();

    assert.ok(opened[0].initialMessage.includes('[Reply from child thread child-1]'));
    abort();
  });

  test('a dormant resumed run cancelled before anything woke it never opens a session and finishes', async () => {
    const { ctx, opened, abort } = probe({ sdkSessionId: 'sdk-4', interrupted: false, childThreadIds: [] });
    const run = createSessionRun(declaration, spec, 'Do the task', ctx);

    abort();
    await run.finished;
    await tick();

    assert.equal(opened.length, 0);
  });
});
