// The switch of a browser in this workspace (store/browsers): the reducer's
// picture of a switch in flight, accepted and refused, and the handler over
// a fake api — one call per browser at a time, a toast per outcome, the
// refusal's "Try again" naming the same command.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Api } from '../../lib/api/index.ts';
import { ApiError } from '../../lib/api/index.ts';
import type { Action, HandlerContext, State } from '../types.ts';
import type { ToastInput } from '../ui/actions.ts';
import { browsersChangedRemotely, browsersRead, setBrowserHere, setBrowserHereDone, setBrowserHereFail } from './actions.ts';
import { setBrowserHereHandler } from './handlers.ts';
import { browsersReducer, initialBrowsers } from './reducer.ts';
import { disconnectFailedWords, disconnectedWords, failureWords, hereName, pairedWords } from './words.ts';

describe('the switch of a browser, in the store', () => {
  it('shows where the user put it while in flight, keeps an accepted one until the list is read, forgets a refused one — and reads the list again either way', () => {
    const flipped = browsersReducer(initialBrowsers, setBrowserHere('b1', 'Home desktop', false));
    const call = flipped.switching.b1!;

    assert.deepEqual(flipped, { changed: 0, switching: { b1: { on: false, settled: false } } });

    const accepted = browsersReducer(flipped, setBrowserHereDone('b1', call));

    assert.deepEqual(accepted, { changed: 1, switching: { b1: { on: false, settled: true } } });
    assert.deepEqual(browsersReducer(accepted, browsersRead()), { changed: 1, switching: {} });
    assert.deepEqual(browsersReducer(flipped, setBrowserHereFail('b1', call)), { changed: 1, switching: {} });
  });

  it('leaves a switch in flight alone when the list is read, and ignores the answer of a call it holds no more', () => {
    const flipped = browsersReducer(initialBrowsers, setBrowserHere('b1', 'Home desktop', true));

    assert.equal(browsersReducer(flipped, browsersRead()), flipped);
    assert.equal(browsersReducer(flipped, setBrowserHereDone('b1', { on: true, settled: false })), flipped);
    assert.equal(browsersReducer(flipped, setBrowserHereFail('b1', { on: true, settled: false })), flipped);
    assert.equal(browsersReducer(flipped, browsersChangedRemotely()).changed, 1);
  });
});

// The handler over the browsers reducer alone: what it calls and what it says.
function harness(browsers: Partial<Api['browsers']>, workspaceName: string | null = 'Personal') {
  let state = initialBrowsers;
  const toasts: ToastInput[] = [];
  const reduce = (action: Action) => {
    state = browsersReducer(state, action);

    if (action.type === 'TOAST_PUSH') {
      toasts.push(action.toast);
    }
  };
  const context = {
    api: { browsers } as unknown as Api,
    dispatch: reduce,
    next: reduce,
    getState: () => ({ browsers: state, session: { me: { workspaceName } } }) as unknown as State,
  } as unknown as HandlerContext;

  return { run: (action: ReturnType<typeof setBrowserHere>) => setBrowserHereHandler(context)(action), toasts, state: () => state };
}

describe('the switch of a browser, over the api', () => {
  it('turns it off, says so, and takes no second flip while the first is in flight', async () => {
    const calls: string[] = [];
    let release = () => {};
    const { run, toasts, state } = harness({
      disableHere: id => {
        calls.push(`off ${id}`);

        return new Promise(resolve => {
          release = () => resolve({ browser: {} as never });
        });
      },
    });
    const first = run(setBrowserHere('b1', 'Home desktop', false));

    await run(setBrowserHere('b1', 'Home desktop', true));
    assert.deepEqual(calls, ['off b1']);
    assert.deepEqual(state().switching, { b1: { on: false, settled: false } });

    release();
    await first;
    assert.deepEqual(state(), { changed: 1, switching: { b1: { on: false, settled: true } } });
    assert.deepEqual(toasts, [{ title: 'Home desktop is off in Personal', desc: 'Agents of Personal can’t use it now; their sessions in it have ended.', state: 'done', icon: 'power-off' }]);
  });

  it('puts the switch back when the server refuses, and offers the same command again', async () => {
    const { run, toasts, state } = harness(
      {
        enableHere: async () => {
          throw new ApiError(502, 'bad_gateway', 'Bad gateway');
        },
      },
      null,
    );

    await run(setBrowserHere('b1', 'Home desktop', true));
    assert.deepEqual(state(), { changed: 1, switching: {} });
    assert.deepEqual(toasts, [
      {
        title: 'Couldn’t turn on Home desktop',
        desc: 'The server didn’t answer (HTTP 502). The switch is back where it was.',
        state: 'err',
        icon: 'circle-x',
        action: { label: 'Try again', browserHere: { id: 'b1', name: 'Home desktop', on: true } },
      },
    ]);
  });

  it('says where it is on in the workspace’s own name', async () => {
    const { run, toasts } = harness({ enableHere: async () => ({ browser: {} as never }) }, null);

    await run(setBrowserHere('b1', 'Home desktop', true));
    assert.equal(toasts[0]?.title, 'Home desktop is on in this workspace');
  });
});

describe('the words of the browser commands', () => {
  it('name the workspace, or “this workspace” when it has no name', () => {
    assert.equal(hereName('Personal'), 'Personal');
    assert.equal(hereName('  '), 'this workspace');
    assert.equal(hereName(null), 'this workspace');
  });

  it('tell a silence, a server that is down and a refusal apart', () => {
    assert.equal(failureWords({ status: 0, code: 'network', message: '' }), 'The server didn’t answer.');
    assert.equal(failureWords({ status: 502, code: 'bad_gateway', message: '' }), 'The server didn’t answer (HTTP 502).');
    assert.equal(failureWords({ status: 404, code: 'not_found', message: '' }), 'The server refused (HTTP 404 · not_found).');
  });

  it('tell a pairing and a disconnect', () => {
    assert.deepEqual(pairedWords('Chrome on Mac', 'Personal'), {
      title: 'Chrome on Mac is connected',
      desc: 'On in Personal and online. Its limits are in the Balabash Agent icon in the toolbar.',
      state: 'done',
      icon: 'circle-check',
    });
    assert.deepEqual(disconnectedWords('Work laptop'), { title: 'Work laptop disconnected', desc: 'It left every workspace; its sessions ended.', state: 'done', icon: 'unplug' });
    assert.equal(disconnectFailedWords('Work laptop', { status: 404, code: 'not_found', message: '' }).desc, 'The server refused (HTTP 404 · not_found). It stays connected.');
  });
});
