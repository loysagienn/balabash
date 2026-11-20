// The session runner's opening move: a fresh run opens its SDK session with
// the spawn prompt at once; a run resumed after an app restart opens the
// saved session (`resume`) — at once with the cut-off note when a turn was
// in flight, otherwise only when the first message arrives, the idle note in
// front of it; a dormant resumed run cancelled before anything woke it never
// opens a session.
//
// The end of a thread: the report the thread left during a turn — through
// the catalog capability `end_thread` (src/core/thread-end.ts) — completes the thread when that
// turn has run its course: not at a text said on the way, and not at a turn
// the user stopped; a run that is over some other way leaves no report
// behind.
//
// Run: npm test  (node:test, native type stripping — no build needed).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SESSION_RESUMED_IDLE_NOTE, SESSION_RESUMED_INTERRUPTED_NOTE } from '../../agents/world/index.ts';
import type { AgentDeclaration, AgentSdkSession, Event, RunContext, RunResume, SdkSessionOptions, SdkTurn } from '../core/contract.ts';
import { leaveReport, reportLeft } from '../core/thread-end.ts';
import { createSessionRun } from './session-run.ts';

const declaration = { name: 'probe', description: 'probe', sdk: 'claude', access: {}, modes: ['headless'], defaultMode: 'headless' } satisfies AgentDeclaration;
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
      close: () => close(),
    };
  };

  const ctx = {
    headless: true,
    parentThreadId: 'operator',
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
    const { ctx, opened, abort } = probe({ sdkSessionId: 'sdk-1', interrupted: true });

    createSessionRun(declaration, spec, 'Do the task', ctx);
    await tick();

    assert.equal(opened.length, 1);
    assert.equal(opened[0].resume, 'sdk-1');
    assert.equal(opened[0].initialMessage, SESSION_RESUMED_INTERRUPTED_NOTE);
    abort();
  });

  test('a resumed idle run stays dormant until a message, which opens the session behind the idle note', async () => {
    const { ctx, opened, pushed, abort } = probe({ sdkSessionId: 'sdk-2', interrupted: false });
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

  test('a resumed run labels a child reply by its sender even on the first message', async () => {
    const { ctx, opened, abort } = probe({ sdkSessionId: 'sdk-3', interrupted: false });
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
    const { ctx, opened, abort } = probe({ sdkSessionId: 'sdk-4', interrupted: false });
    const run = createSessionRun(declaration, spec, 'Do the task', ctx);

    abort();
    await run.finished;
    await tick();

    assert.equal(opened.length, 0);
  });
});

describe('createSessionRun ending', () => {
  // A run over a session whose turns the test ends one by one; what the run
  // tells the log is recorded.
  function ending(threadId: string, headless: boolean) {
    const turns: Array<(turn: SdkTurn) => void> = [];
    const completed: unknown[] = [];
    const told: string[] = [];
    const controller = new AbortController();
    const session: AgentSdkSession = {
      push: () => {},
      turns: (async function* (): AsyncGenerator<SdkTurn> {
        for (;;) {
          yield await new Promise<SdkTurn>(resolve => turns.push(resolve));
        }
      })(),
      close: () => {},
    };
    const ctx = {
      headless,
      threadId,
      workspaceId: 'workspace-1',
      signal: controller.signal,
      harness: { sdkSession: () => session },
      stateDir: '/tmp',
      deliverTurnText: async (text: string) => {
        told.push(text);
      },
      complete: async (summary: unknown, meta: unknown) => {
        completed.push({ summary, meta });
      },
    } as unknown as RunContext;
    const run = createSessionRun(declaration, spec, 'Do the task', ctx);

    return {
      run,
      completed,
      told,
      abort: () => controller.abort(),
      endTurn: async (text: string) => {
        await tick();
        turns.shift()!({ text });
        await tick();
      },
      // What the session says besides the end of a turn that ran its
      // course: a text on the way, the end of a turn that was cut.
      says: async (turn: SdkTurn) => {
        await tick();
        turns.shift()!(turn);
        await tick();
      },
    };
  }

  test('a turn without a report goes on; the report left in a turn completes the thread when the turn is over', async () => {
    const { run, completed, told, endTurn } = ending('thread-ending-1', false);

    await endTurn('Working on it.');
    assert.deepEqual([told, completed], [['Working on it.'], []]);

    // What `end_thread` does in the middle of a turn.
    leaveReport('thread-ending-1', {
      title: 'Thing built',
      description: 'Built the thing.',
      summary: { text: 'It is built.', fileIds: ['file-1'] },
      project: { id: 'project-1', slug: 'things' },
    });
    await endTurn('All done, goodbye.');
    await run.finished;

    // A thread that talks to the user says its last words; the report goes
    // with the terminal, the project named at the end with it.
    assert.deepEqual(told, ['Working on it.', 'All done, goodbye.']);
    assert.deepEqual(completed, [
      {
        summary: { text: 'It is built.', fileIds: ['file-1'] },
        meta: { title: 'Thing built', description: 'Built the thing.', project: { id: 'project-1', slug: 'things' } },
      },
    ]);
    assert.equal(reportLeft('thread-ending-1'), null);
  });

  test('a headless thread ends with its report alone, and a run cancelled first leaves no report behind', async () => {
    const headless = ending('thread-ending-2', true);

    leaveReport('thread-ending-2', { title: 'Looked', description: 'Looked at the page.', summary: { text: 'Nothing there.' } });
    await headless.endTurn('Bye.');
    await headless.run.finished;

    // The parent gets the summary; the goodbye would only repeat it.
    assert.deepEqual(headless.told, []);
    assert.deepEqual(headless.completed, [{ summary: { text: 'Nothing there.' }, meta: { title: 'Looked', description: 'Looked at the page.' } }]);

    const cancelled = ending('thread-ending-3', false);

    await tick();
    leaveReport('thread-ending-3', { title: 'T', description: 'D', summary: { text: 'S' } });
    cancelled.abort();
    await cancelled.run.finished;

    assert.deepEqual(cancelled.completed, []);
    assert.equal(reportLeft('thread-ending-3'), null);
  });

  test('a text said on the way does not end the thread: the report waits for the end of the turn', async () => {
    const { run, completed, told, says, endTurn } = ending('thread-ending-4', false);

    await says({ text: 'Wrapping up.', ongoing: true });
    leaveReport('thread-ending-4', { title: 'T', description: 'D', summary: { text: 'S' } });
    // The session gives the words after `end_thread` while the turn still
    // runs: they are delivered, the thread stays, the report stays in place.
    await says({ text: 'All done, goodbye.', ongoing: true });

    assert.deepEqual([told, completed], [['Wrapping up.', 'All done, goodbye.'], []]);
    assert.notEqual(reportLeft('thread-ending-4'), null);

    await endTurn('');
    await run.finished;

    assert.deepEqual(told, ['Wrapping up.', 'All done, goodbye.']);
    assert.deepEqual(completed, [{ summary: { text: 'S' }, meta: { title: 'T', description: 'D' } }]);
    assert.equal(reportLeft('thread-ending-4'), null);
  });

  test('a turn the user stopped leaves the thread open, and the report left in it is gone', async () => {
    const { run, completed, told, says, endTurn, abort } = ending('thread-ending-5', false);

    leaveReport('thread-ending-5', { title: 'T', description: 'D', summary: { text: 'S' } });
    await says({ text: '', interrupted: true });

    assert.deepEqual(completed, []);
    assert.equal(reportLeft('thread-ending-5'), null);

    // The next turn is an ordinary one: nothing of the stopped turn ends it.
    await endTurn('Still here.');

    assert.deepEqual([told, completed], [['Still here.'], []]);

    abort();
    await run.finished;
  });
});
