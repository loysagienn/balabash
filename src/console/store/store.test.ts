// The store as a whole: real reducers and middleware, a fake Api. Covers
// the start-up cascade (session → snapshot → route data), sign-in and
// sign-out, the threads and feed folds of events (idempotent by seq), the
// stale-answer rule of the handlers.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Api } from '../lib/api/index.ts';
import { ApiError } from '../lib/api/index.ts';
import type { StoreEnhancer } from 'redux';
import { createStore } from './index.ts';
import type { Action, AppStore } from './index.ts';
import { eventAction } from './events.ts';
import { routeTo } from './router/actions.ts';
import { login, logout, sessionCheck, sessionLost } from './session/actions.ts';
import { loadThreadEvents } from './threads/actions.ts';
import { selectRunningCount } from './threads/selectors.ts';
import { makeSelectThreadEvents } from './feed/selectors.ts';
import { selectThreadState } from './sessions/selectors.ts';
import { ME, event, resetSeq, snapshot, thread } from './fixtures.ts';

type Calls = { name: string; args: unknown[] }[];

type ApiOverrides = Omit<Partial<Api>, 'threads'> & { threads?: Partial<Api['threads']> };

function fakeApi(overrides: ApiOverrides = {}, calls: Calls = []): Api {
  const wrap =
    <A extends unknown[], T>(name: string, impl: (...args: A) => Promise<T>) =>
    (...args: A) => {
      calls.push({ name, args });

      return impl(...args);
    };
  const base: Omit<Api, 'threads'> = {
    me: async () => ME,
    auth: async () => ME,
    logout: async () => ({ ok: true as const }),
    snapshot: async () => snapshot(),
    ...overrides,
  };
  const threads: Api['threads'] = {
    list: async () => ({ threads: [], nextCursor: null }),
    get: async () => ({ thread: thread({ id: 't1' }), headless: false }),
    events: async () => ({ events: [], nextCursor: null }),
    sendMessage: async () => ({}),
    ...overrides.threads,
  };

  return {
    me: wrap('me', base.me),
    auth: wrap('auth', base.auth),
    logout: wrap('logout', base.logout),
    snapshot: wrap('snapshot', base.snapshot),
    threads: {
      list: wrap('threads.list', threads.list),
      get: wrap('threads.get', threads.get),
      events: wrap('threads.events', threads.events),
      sendMessage: wrap('threads.sendMessage', threads.sendMessage),
    },
  };
}

async function dispatched(store: AppStore, action: Action): Promise<void> {
  await (store.dispatch(action) as unknown as Promise<void> | void);
}

// Lets the cascade of handlers (each awaiting its api call) settle.
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

// An enhancer shaped like the Redux DevTools instrument: the store it builds
// runs a lifted reducer and its dispatch wraps every action into
// PERFORM_ACTION — whatever is composed outside it sees only the wrappers.
type Lifted = { type: 'PERFORM_ACTION'; action: unknown };

const liftingEnhancer: StoreEnhancer = next => (reducer, preloadedState) => {
  const lifted = (state: unknown, action: unknown) =>
    (reducer as (state: unknown, action: unknown) => unknown)(state, (action as Lifted).type === 'PERFORM_ACTION' ? (action as Lifted).action : action);
  const store = next(lifted as typeof reducer, preloadedState);

  return {
    ...store,
    dispatch: (action => {
      store.dispatch({ type: 'PERFORM_ACTION', action } as unknown as Parameters<typeof store.dispatch>[0]);

      return action;
    }) as typeof store.dispatch,
  };
};

describe('session start-up', () => {
  it('checks the session, loads the snapshot and the route data', async () => {
    const calls: Calls = [];
    const api = fakeApi(
      {
        snapshot: async () => snapshot({ asOfSeq: 50n, threads: [thread({ id: 't1' }), thread({ id: 'main', parentId: null, agent: 'coordinator' })] }),
      },
      calls,
    );
    const store = createStore({ api, initialRoute: { key: 'thread', id: 't1' } });

    assert.equal(store.getState().session.status, 'loading');
    await dispatched(store, sessionCheck());
    await settle();

    const state = store.getState();

    assert.equal(state.session.status, 'signed-in');
    assert.deepEqual(state.session.me, ME);
    assert.equal(state.stream.asOfSeq, 50n);
    assert.equal(selectRunningCount(state), 1);
    assert.deepEqual(
      calls.map(call => call.name),
      ['me', 'snapshot', 'threads.events'],
    );
    assert.deepEqual(calls[2].args, ['t1', { before: 51n, limit: 500 }]);
    assert.equal(state.feed.byThread.t1.exhausted, true);
    assert.equal(state.feed.byThread.t1.knownFrom, null);
  });

  it('a 401 from /me is anonymous; sign-in loads the snapshot', async () => {
    const calls: Calls = [];
    const api = fakeApi(
      {
        me: async () => {
          throw new ApiError(401, 'unauthorized', 'No valid session');
        },
        auth: async code => {
          if (code !== 'GOOD') {
            throw new ApiError(401, 'invalid_code', 'The code is invalid or expired');
          }

          return ME;
        },
      },
      calls,
    );
    const store = createStore({ api, initialRoute: { key: 'home' } });

    await dispatched(store, sessionCheck());
    assert.equal(store.getState().session.status, 'anonymous');

    await dispatched(store, login('BAD'));
    assert.equal(store.getState().session.status, 'anonymous');
    assert.equal(store.getState().session.login.error?.status, 401);

    await dispatched(store, login('GOOD'));
    await settle();
    assert.equal(store.getState().session.status, 'signed-in');
    assert.equal(store.getState().session.login.error, null);
    assert.equal(store.getState().stream.asOfSeq, 100n);
  });

  it('a network failure of the check is an error state, not anonymous', async () => {
    const api = fakeApi({
      me: async () => {
        throw new TypeError('Failed to fetch');
      },
    });
    const store = createStore({ api, initialRoute: { key: 'home' } });

    await dispatched(store, sessionCheck());
    assert.equal(store.getState().session.status, 'error');
    assert.equal(store.getState().session.error?.code, 'network');
  });

  it('sign-out and a lost session reset everything but the route', async () => {
    const api = fakeApi({ snapshot: async () => snapshot({ threads: [thread({ id: 't1' })] }) });
    const store = createStore({ api, initialRoute: { key: 'threads' } });

    await dispatched(store, sessionCheck());
    await settle();
    assert.equal(Object.keys(store.getState().threads.byId).length, 1);

    await dispatched(store, logout());
    assert.equal(store.getState().session.status, 'anonymous');
    assert.equal(store.getState().stream.asOfSeq, null);
    assert.deepEqual(store.getState().threads.byId, {});
    assert.deepEqual(store.getState().router.route, { key: 'threads' });

    await dispatched(store, sessionCheck());
    await settle();
    assert.equal(store.getState().session.status, 'signed-in');
    store.dispatch(sessionLost());
    assert.equal(store.getState().session.status, 'anonymous');
    assert.equal(store.getState().stream.asOfSeq, null);
  });
});

describe('threads from events', () => {
  it('folds thread.started and the terminals; a replayed seq changes nothing', async () => {
    resetSeq(200n);

    const store = createStore({ api: fakeApi(), initialRoute: { key: 'home' } });
    const started = event({ type: 'thread.started', threadId: 't9', targetThreadId: 'main', payload: { agent: 'engineer', title: 'Fix', projectId: 'p1' } });

    store.dispatch(eventAction(started));

    const created = store.getState().threads.byId.t9;

    assert.equal(created.status, 'active');
    assert.equal(created.title, 'Fix');
    assert.equal(created.projectId, 'p1');
    assert.equal(created.parentId, 'main');
    assert.deepEqual(store.getState().threads.childrenOf.main, ['t9']);
    assert.equal(store.getState().stream.lastSeq, 200n);

    const progress = event({ type: 'thread.progress', threadId: 't9', payload: { text: 'working' } });

    store.dispatch(eventAction(progress));
    assert.equal(store.getState().threads.byId.t9.updatedAt, progress.createdAt);

    const before = store.getState();

    store.dispatch(eventAction(started));
    assert.equal(store.getState().threads, before.threads);
    assert.equal(store.getState().feed, before.feed);

    const completed = event({
      type: 'thread.completed',
      threadId: 't9',
      targetThreadId: 'main',
      payload: { summary: { text: 'done' }, title: 'Fixed it', description: 'd' },
    });

    store.dispatch(eventAction(completed));

    const done = store.getState().threads.byId.t9;

    assert.equal(done.status, 'completed');
    assert.equal(done.title, 'Fixed it');
    assert.equal(done.description, 'd');
    assert.deepEqual(done.summary, { text: 'done' });
    assert.equal(done.terminalSeq, completed.seq);
    assert.equal(selectRunningCount(store.getState()), 0);

    // The feed of both the author and the addressee saw the events.
    assert.deepEqual(store.getState().feed.byThread.t9.seqs, [started.seq, progress.seq, completed.seq].map(String));
    assert.deepEqual(store.getState().feed.byThread.main.seqs, [started.seq, completed.seq].map(String));
  });
});

describe('thread events (feed)', () => {
  it('merges a loaded chunk below the tail, keeps order and drops a stale answer', async () => {
    resetSeq(10n);

    const older = [event({ type: 'user.message', threadId: 't1', actor: 'user', payload: { text: 'hi' } }), event({ type: 'agent.message', threadId: 't1', payload: { content: [] } })];
    let resolveEvents: ((value: { events: typeof older; nextCursor: bigint | null }) => void) | null = null;
    const api = fakeApi({
      snapshot: async () => snapshot({ asOfSeq: 20n }),
      threads: {
        events: () =>
          new Promise(resolve => {
            resolveEvents = resolve;
          }),
      },
    });
    const store = createStore({ api, initialRoute: { key: 'home' } });

    await dispatched(store, sessionCheck());
    await settle();

    // The tail brings a newer event before the chunk arrives.
    const live = event({ type: 'thread.progress', seq: 25n, threadId: 't1', payload: { text: 'x' } });

    store.dispatch(eventAction(live));

    const loading = dispatched(store, loadThreadEvents('t1', null));

    assert.deepEqual(store.getState().feed.byThread.t1.request, { before: null });
    resolveEvents!({ events: [...older].reverse(), nextCursor: 10n });
    await loading;

    const feed = store.getState().feed.byThread.t1;

    assert.deepEqual(feed.seqs, ['10', '11', '25']);
    assert.equal(feed.knownFrom, 10n);
    assert.equal(feed.exhausted, false);
    assert.equal(feed.request, null);

    const select = makeSelectThreadEvents();
    const events = select(store.getState(), 't1');

    assert.deepEqual(
      events.map(e => e.type),
      ['user.message', 'agent.message', 'thread.progress'],
    );
    assert.equal(select(store.getState(), 't1'), events);

    // A second request supersedes the first: the first answer is dropped.
    const first = dispatched(store, loadThreadEvents('t1', 10n));
    const firstResolve = resolveEvents!;

    store.dispatch(loadThreadEvents('t1', 10n));
    store.dispatch({ type: 'LOAD_THREAD_EVENTS_FAIL', threadId: 't1', before: 10n, error: { status: 0, code: 'network', message: 'x' } });
    store.dispatch(routeTo({ key: 'thread', id: 't1' }));
    assert.equal(store.getState().feed.byThread.t1.request, null);
    firstResolve({ events: [event({ type: 'thread.started', seq: 5n, threadId: 't1', payload: { agent: 'engineer' } })], nextCursor: null });
    await first;
    assert.deepEqual(store.getState().feed.byThread.t1.seqs, ['10', '11', '25']);
    assert.equal(store.getState().feed.byThread.t1.knownFrom, 10n);
  });
});

describe('route data', () => {
  it('loads the threads page for the list route once per filter set', async () => {
    const calls: Calls = [];
    const api = fakeApi(
      {
        snapshot: async () =>
          snapshot({
            projects: [{ id: 'p1', slug: 'balabash', title: 'Balabash', description: '', archived: false, createdAt: new Date(), updatedAt: new Date() }],
          }),
        threads: { list: async () => ({ threads: [thread({ id: 'a', createdSeq: 7n }), thread({ id: 'b', createdSeq: 5n, status: 'completed' })], nextCursor: null }) },
      },
      calls,
    );
    const store = createStore({ api, initialRoute: { key: 'threads', status: 'active', project: 'balabash' } });

    await dispatched(store, sessionCheck());
    await settle();

    const listCalls = calls.filter(call => call.name === 'threads.list');

    assert.equal(listCalls.length, 1);
    assert.deepEqual(listCalls[0].args, [{ status: 'active', projectId: 'p1', limit: 50 }]);
    assert.deepEqual(store.getState().threads.list.ids, ['a', 'b']);
    assert.equal(store.getState().threads.list.loading, false);

    await dispatched(store, routeTo({ key: 'threads', status: 'active', project: 'balabash' }, { replace: true }));
    await settle();
    assert.equal(calls.filter(call => call.name === 'threads.list').length, 1);

    await dispatched(store, routeTo({ key: 'threads' }));
    await settle();
    assert.equal(calls.filter(call => call.name === 'threads.list').length, 2);
    assert.deepEqual(calls.at(-1)?.args, [{ limit: 50 }]);
  });

  // Regression: with the Redux DevTools extension installed, the console
  // showed SESSION_CHECK in the extension and nothing else happened — the
  // enhancer sat outside the middleware, which saw only PERFORM_ACTION.
  it('runs the handlers with a DevTools-like lifting enhancer composed in', async () => {
    const calls: Calls = [];
    const store = createStore({ api: fakeApi({}, calls), initialRoute: { key: 'home' }, enhancer: liftingEnhancer });

    await dispatched(store, sessionCheck());
    await settle();
    assert.equal(store.getState().session.status, 'signed-in');
    assert.deepEqual(
      calls.map(call => call.name),
      ['me', 'snapshot'],
    );
  });

  it('closes the More sheet on navigation', () => {
    const store = createStore({ api: fakeApi(), initialRoute: { key: 'home' } });

    store.dispatch({ type: 'MORE_SHEET_OPEN' });
    assert.equal(store.getState().ui.moreSheet, true);
    store.dispatch(routeTo({ key: 'apps' }));
    assert.equal(store.getState().ui.moreSheet, false);
    assert.deepEqual(store.getState().router, { route: { key: 'apps' }, source: 'app', replace: false });
  });
});

describe('sessions from events', () => {
  it('folds session.state and session.context per thread; a terminal drops the session; the snapshot seeds it', async () => {
    resetSeq(300n);

    const api = fakeApi({
      snapshot: async () =>
        snapshot({
          threads: [thread({ id: 't1' }), thread({ id: 't2' }), thread({ id: 'done', status: 'completed' })],
          sessions: { t1: { state: 'run', context: { used: 10_000, max: 200_000 } } },
        }),
    });
    const store = createStore({ api, initialRoute: { key: 'home' } });

    await dispatched(store, sessionCheck());
    await settle();
    assert.deepEqual(store.getState().sessions, { t1: { state: 'run', context: { used: 10_000, max: 200_000 } } });
    assert.equal(selectThreadState(store.getState(), 't1'), 'run');
    assert.equal(selectThreadState(store.getState(), 't2'), 'wait');
    assert.equal(selectThreadState(store.getState(), 'done'), 'done');
    assert.equal(selectThreadState(store.getState(), 'nope'), null);

    store.dispatch(eventAction(event({ type: 'session.state', threadId: 't2', payload: { state: 'run' } })));
    assert.deepEqual(store.getState().sessions.t2, { state: 'run', context: null });

    const before = store.getState().sessions;

    store.dispatch(eventAction(event({ type: 'session.tool.started', threadId: 't2', payload: { toolUseId: 'a', name: 'Bash', input: {} } })));
    assert.equal(store.getState().sessions, before);

    store.dispatch(eventAction(event({ type: 'session.context', threadId: 't2', payload: { totalTokens: 48_659, maxTokens: 1_000_000, percentage: 5 } })));
    store.dispatch(eventAction(event({ type: 'session.state', threadId: 't2', payload: { state: 'wait' } })));
    assert.deepEqual(store.getState().sessions.t2, { state: 'wait', context: { used: 48_659, max: 1_000_000 } });
    assert.equal(selectThreadState(store.getState(), 't2'), 'wait');

    store.dispatch(eventAction(event({ type: 'thread.completed', threadId: 't2', targetThreadId: 'main', payload: { summary: { text: 'ok' } } })));
    assert.equal(store.getState().sessions.t2, undefined);
    assert.equal(selectThreadState(store.getState(), 't2'), 'done');
    assert.deepEqual(store.getState().sessions, { t1: { state: 'run', context: { used: 10_000, max: 200_000 } } });
  });
});
