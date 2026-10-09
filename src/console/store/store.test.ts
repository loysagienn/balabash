// The store as a whole: real reducers and middleware, a fake Api. Covers
// the start-up cascade (session → snapshot → route data), sign-in and
// sign-out, the threads and feed folds of events (idempotent by seq), the
// stale-answer rule of the handlers.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Thread } from '../../core/contract.ts';
import type { Api } from '../lib/api/index.ts';
import type { ThreadsResponse } from '../../api/contract.ts';
import { ApiError } from '../lib/api/index.ts';
import type { StoreEnhancer } from 'redux';
import { createStore } from './index.ts';
import type { AppRoute } from '../lib/router/routes.ts';
import type { Action, AppStore } from './index.ts';
import { eventAction } from './events.ts';
import { routeTo } from './router/actions.ts';
import { login, logout, sessionCheck, sessionLost } from './session/actions.ts';
import { commandThread, loadThread, loadThreadEvents, loadThreads, sendMessage } from './threads/actions.ts';
import { setComposerDraft } from './ui/actions.ts';
import { hasLoadedPage, makeSelectAgentThreads, selectActiveCountIn, selectKnownAgents, selectLatestFinishedThread, selectListThreads, selectMainThread, selectRunningCount, selectRunningCountByAgent, selectRunningCountByProject } from './threads/selectors.ts';
import { SEARCH_DEBOUNCE_MS } from './threads/handlers.ts';
import { selectActiveProjects, selectArchivedProjectCount } from './projects/selectors.ts';
import { selectConnections, selectConnectionsNeedingAction } from './connections/selectors.ts';
import { makeSelectThreadEvents } from './feed/selectors.ts';
import { selectThreadState } from './sessions/selectors.ts';
import { ME, event, resetSeq, snapshot, thread } from './fixtures.ts';

type Calls = { name: string; args: unknown[] }[];

type ApiOverrides = Omit<Partial<Api>, 'threads' | 'workspace'> & { threads?: Partial<Api['threads']> };

// The file area is Query, not the store: handlers never call it.
const WORKSPACE: Api['workspace'] = {
  node: async () => ({ kind: 'dir', path: '', directories: [], files: [] }),
  text: async () => '',
};

function fakeApi(overrides: ApiOverrides = {}, calls: Calls = []): Api {
  const wrap =
    <A extends unknown[], T>(name: string, impl: (...args: A) => Promise<T>) =>
    (...args: A) => {
      calls.push({ name, args });

      return impl(...args);
    };
  const base: Omit<Api, 'threads' | 'workspace'> = {
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
    interrupt: async () => ({}),
    cancel: async () => ({}),
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
      interrupt: wrap('threads.interrupt', threads.interrupt),
      cancel: wrap('threads.cancel', threads.cancel),
    },
    workspace: WORKSPACE,
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

describe('sessions from events', () => {
  it('folds the session of an active thread only; a late tail after the terminal is not a session', () => {
    resetSeq(300n);

    const store = createStore({ api: fakeApi(), initialRoute: { key: 'home' } });

    store.dispatch(eventAction(event({ type: 'thread.started', threadId: 't9', targetThreadId: 'main', payload: { agent: 'engineer' } })));
    assert.equal(selectThreadState(store.getState(), 't9'), 'wait');

    store.dispatch(eventAction(event({ type: 'session.state', threadId: 't9', payload: { state: 'run' } })));
    store.dispatch(eventAction(event({ type: 'session.context', threadId: 't9', payload: { totalTokens: 10, maxTokens: 100, percentage: 10 } })));
    assert.deepEqual(store.getState().sessions.t9, { state: 'run', context: { used: 10, max: 100 } });
    assert.equal(selectThreadState(store.getState(), 't9'), 'run');

    // An event of the session that changes nothing keeps the domain's object.
    const before = store.getState().sessions;

    store.dispatch(eventAction(event({ type: 'session.tool.started', threadId: 't9', payload: { toolUseId: 'a', name: 'Bash', input: {} } })));
    assert.equal(store.getState().sessions, before);

    store.dispatch(eventAction(event({ type: 'thread.completed', threadId: 't9', targetThreadId: 'main', payload: { summary: { text: 'done' } } })));
    assert.equal(store.getState().sessions.t9, undefined);
    assert.equal(selectThreadState(store.getState(), 't9'), 'done');

    // The journal's late tail (the log allows it) does not bring the session back.
    store.dispatch(eventAction(event({ type: 'session.turn', threadId: 't9', payload: {} })));
    store.dispatch(eventAction(event({ type: 'session.state', threadId: 't9', payload: { state: 'wait' } })));
    store.dispatch(eventAction(event({ type: 'session.context', threadId: 't9', payload: { totalTokens: 12, maxTokens: 100, percentage: 12 } })));
    assert.equal(store.getState().sessions.t9, undefined);
    assert.equal(selectThreadState(store.getState(), 't9'), 'done');

    // A thread the store does not know has no session either.
    store.dispatch(eventAction(event({ type: 'session.state', threadId: 'unknown', payload: { state: 'run' } })));
    assert.deepEqual(store.getState().sessions, {});
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
    assert.deepEqual(listCalls[0].args[0], { status: 'active', projectId: 'p1', limit: 50 });
    assert.ok(listCalls[0].args[1] instanceof AbortSignal);
    assert.deepEqual(store.getState().threads.list.ids, ['a', 'b']);
    assert.equal(store.getState().threads.list.loading, false);

    await dispatched(store, routeTo({ key: 'threads', status: 'active', project: 'balabash' }, { replace: true }));
    await settle();
    assert.equal(calls.filter(call => call.name === 'threads.list').length, 1);

    await dispatched(store, routeTo({ key: 'threads' }));
    await settle();
    assert.equal(calls.filter(call => call.name === 'threads.list').length, 2);
    assert.deepEqual(calls.at(-1)?.args[0], { limit: 50 });
  });

  // Regression (review 080661d, R2): a status picked while the first page of
  // the previous status was still in flight changed the route and the
  // segment, but the list kept waiting for — and then showed — the old set.
  it('retargets the list when the filters change during a request and drops the old answer', async () => {
    const calls: Calls = [];
    const answers: ((page: { threads: Thread[]; nextCursor: bigint | null }) => void)[] = [];
    const api = fakeApi({ threads: { list: () => new Promise(resolve => answers.push(resolve)) } }, calls);
    const store = createStore({ api, initialRoute: { key: 'threads', status: 'active' } });

    await dispatched(store, sessionCheck());
    await settle();
    assert.equal(answers.length, 1);

    await dispatched(store, routeTo({ key: 'threads', status: 'completed' }, { replace: true }));
    await settle();
    assert.equal(answers.length, 2);
    assert.deepEqual(calls.filter(call => call.name === 'threads.list').map(call => call.args[0]), [
      { status: 'active', limit: 50 },
      { status: 'completed', limit: 50 },
    ]);
    assert.equal(store.getState().threads.list.filters?.status, 'completed');
    assert.equal(store.getState().threads.list.loading, true);

    // The late answer of the Active set is dropped; the list still waits for Completed.
    answers[0]!({ threads: [thread({ id: 'a', createdSeq: 7n })], nextCursor: null });
    await settle();
    assert.equal(store.getState().threads.list.loading, true);
    assert.deepEqual(store.getState().threads.list.ids, []);
    assert.deepEqual(selectListThreads(store.getState()), []);

    answers[1]!({ threads: [thread({ id: 'b', createdSeq: 5n, status: 'completed' })], nextCursor: null });
    await settle();
    assert.equal(store.getState().threads.list.loading, false);
    assert.deepEqual(selectListThreads(store.getState()).map(t => t.id), ['b']);

    // The same during a later page: the next set starts over from its first page.
    await dispatched(store, routeTo({ key: 'threads' }, { replace: true }));
    await settle();
    answers[2]!({ threads: [thread({ id: 'c', createdSeq: 9n })], nextCursor: 9n });
    await settle();
    void store.dispatch(loadThreads(store.getState().threads.list.filters!, 9n));
    await dispatched(store, routeTo({ key: 'threads', status: 'failed' }, { replace: true }));
    await settle();
    answers[3]!({ threads: [thread({ id: 'd', createdSeq: 3n })], nextCursor: null });
    await settle();
    assert.equal(calls.filter(call => call.name === 'threads.list').length, 5);
    assert.deepEqual(calls.at(-1)?.args[0], { status: 'failed', limit: 50 });
    assert.deepEqual(store.getState().threads.list.ids, []);
    assert.equal(store.getState().threads.list.loading, true);
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

  it('keeps the router state as is on ROUTE_TO to the current route', () => {
    const store = createStore({ api: fakeApi(), initialRoute: { key: 'thread', id: 'main' } });
    const before = store.getState().router;

    store.dispatch({ type: 'MORE_SHEET_OPEN' });
    store.dispatch(routeTo({ key: 'thread', id: 'main' }));
    assert.equal(store.getState().router, before);
    assert.equal(store.getState().ui.moreSheet, false);
    store.dispatch(routeTo({ key: 'thread', id: 'main' }, { source: 'history' }));
    assert.equal(store.getState().router, before);
    store.dispatch(routeTo({ key: 'thread', id: 'other' }));
    assert.notEqual(store.getState().router, before);
    assert.deepEqual(store.getState().router.route, { key: 'thread', id: 'other' });
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

describe('threads list projection', () => {
  const page = [thread({ id: 'a', createdSeq: 7n }), thread({ id: 'b', createdSeq: 5n, status: 'completed' })];

  async function listStore(route: AppRoute, nextCursor: bigint | null = null, calls: Calls = []) {
    const api = fakeApi(
      {
        snapshot: async () => snapshot({ asOfSeq: 50n, threads: [thread({ id: 'old', createdSeq: 2n, status: 'completed' }), thread({ id: 'main', parentId: null, agent: 'coordinator' })] }),
        threads: { list: async () => ({ threads: page, nextCursor }) },
      },
      calls,
    );
    const store = createStore({ api, initialRoute: route });

    await dispatched(store, sessionCheck());
    await settle();

    return store;
  }

  it('shows the loaded range of the store, newest first, and nothing before the first page', async () => {
    const calls: Calls = [];
    const api = fakeApi({ threads: { list: () => new Promise(() => {}) } }, calls);
    const pending = createStore({ api, initialRoute: { key: 'threads' } });

    await dispatched(pending, sessionCheck());
    await settle();
    assert.deepEqual(selectListThreads(pending.getState()), []);

    // A full page: the range stops at its oldest row — the snapshot's older thread waits for the next page.
    const partial = await listStore({ key: 'threads' }, 5n);

    assert.deepEqual(
      selectListThreads(partial.getState()).map(t => t.id),
      ['a', 'b'],
    );

    // An exhausted cursor opens the range: the snapshot's threads join in order.
    const full = await listStore({ key: 'threads' });

    assert.deepEqual(
      selectListThreads(full.getState()).map(t => t.id),
      ['a', 'b', 'old'],
    );
  });

  // Regression (review 080661d, R3): a failed first page looked like an
  // exhausted one — no ids, no cursor — and opened the range to the whole
  // snapshot, shown under a "couldn't load earlier threads" note.
  it('shows no rows after a failed first page until a retry lands', async () => {
    let fail = true;
    const api = fakeApi({
      snapshot: async () => snapshot({ asOfSeq: 50n, threads: [thread({ id: 'old', createdSeq: 2n, status: 'completed' })] }),
      threads: {
        list: async () => {
          if (fail) {
            throw new ApiError(500, 'internal', 'boom');
          }

          return { threads: page, nextCursor: null };
        },
      },
    });
    const store = createStore({ api, initialRoute: { key: 'threads' } });

    await dispatched(store, sessionCheck());
    await settle();

    const failed = store.getState().threads.list;

    assert.equal(failed.error?.message, 'boom');
    assert.deepEqual(failed.ids, []);
    assert.equal(hasLoadedPage(failed), false);
    assert.deepEqual(selectListThreads(store.getState()), []);

    fail = false;
    await dispatched(store, loadThreads(failed.filters!, null));
    await settle();
    assert.equal(hasLoadedPage(store.getState().threads.list), true);
    assert.deepEqual(selectListThreads(store.getState()).map(t => t.id), ['a', 'b', 'old']);
  });

  it('lets the tail insert a new thread and move a finished one between status filters', async () => {
    const store = await listStore({ key: 'threads', status: 'active' }, 5n);

    assert.deepEqual(selectListThreads(store.getState()).map(t => t.id), ['a']);

    store.dispatch(eventAction(event({ type: 'thread.started', seq: 60n, threadId: 'n', targetThreadId: 'main', payload: { agent: 'designer', title: 'New' } })));
    assert.deepEqual(selectListThreads(store.getState()).map(t => t.id), ['n', 'a']);

    store.dispatch(eventAction(event({ type: 'thread.completed', seq: 61n, threadId: 'a', payload: { summary: { text: 'done' } } })));
    assert.deepEqual(selectListThreads(store.getState()).map(t => t.id), ['n']);
  });

  it('reloads the list for the route’s agent and search, the search once the typing rests, and reads the rows by the same rules', async () => {
    const calls: Calls = [];
    const store = await listStore({ key: 'threads' }, null, calls);

    store.dispatch(eventAction(event({ type: 'thread.started', seq: 60n, threadId: 'n', targetThreadId: 'main', payload: { agent: 'designer', title: 'Slug scheme' } })));

    await dispatched(store, routeTo({ key: 'threads', agent: 'designer' }, { replace: true }));
    await settle();
    assert.deepEqual(calls.filter(call => call.name === 'threads.list').map(call => call.args[0]), [{ limit: 50 }, { agent: 'designer', limit: 50 }]);
    // The page (a, b — engineer's) is loaded, the rows are read by the filters: only the designer's thread.
    assert.deepEqual(selectListThreads(store.getState()).map(t => t.id), ['n']);

    // Typing: the route changes at every keystroke, the request waits for the pause.
    await dispatched(store, routeTo({ key: 'threads', q: 'SL' }, { replace: true }));
    await dispatched(store, routeTo({ key: 'threads', q: 'SLUG' }, { replace: true }));
    await settle();
    assert.equal(calls.filter(call => call.name === 'threads.list').length, 2);
    assert.equal(store.getState().threads.list.loading, true);
    await new Promise(resolve => setTimeout(resolve, SEARCH_DEBOUNCE_MS + 20));
    assert.deepEqual(calls.filter(call => call.name === 'threads.list').map(call => call.args[0]).slice(2), [{ q: 'SLUG', limit: 50 }]);
    assert.deepEqual(selectListThreads(store.getState()).map(t => t.id), ['n']);
    assert.deepEqual(selectKnownAgents(store.getState()), ['coordinator', 'designer', 'engineer']);
  });

  it('pins the main thread outside the rows and counts the set: the server’s closed ones, the store’s active ones, a terminal moving one across', async () => {
    const counts = { active: 9, completed: 1290, failed: 12, cancelled: 6 };
    const api = fakeApi({
      snapshot: async () => snapshot({ asOfSeq: 50n, threads: [thread({ id: 'main', parentId: null, agent: 'coordinator', createdSeq: 1n }), thread({ id: 'x', createdSeq: 9n, agent: 'designer' })] }),
      threads: { list: async query => (query.before ? { threads: [], nextCursor: null } : { threads: page, nextCursor: 5n, counts, countsAsOfSeq: 50n }) },
    });
    const store = createStore({ api, initialRoute: { key: 'threads' } });

    await dispatched(store, sessionCheck());
    await settle();

    const state = store.getState();

    assert.equal(selectMainThread(state)?.id, 'main');
    assert.deepEqual(selectListThreads(state).map(t => t.id), ['x', 'a', 'b']);
    assert.deepEqual(state.threads.list.counts, counts);
    // The active ones are the store's: two agent threads, the main thread aside.
    assert.equal(selectActiveCountIn(state, state.threads.list.filters!), 2);
    assert.equal(selectActiveCountIn(state, { ...state.threads.list.filters!, agent: 'designer' }), 1);

    // A terminal above the stamp of the counts adds one under its status; the
    // active number is the store's (one fewer now), `counts.active` stays the server's.
    store.dispatch(eventAction(event({ type: 'thread.failed', seq: 61n, threadId: 'x', payload: { error: 'boom' } })));
    assert.deepEqual(store.getState().threads.list.counts, { ...counts, failed: 13 });
    assert.equal(selectActiveCountIn(store.getState(), state.threads.list.filters!), 1);

    // A later page keeps the counts of the set.
    await dispatched(store, loadThreads(store.getState().threads.list.filters!, 5n));
    await settle();
    assert.deepEqual(store.getState().threads.list.counts, { ...counts, failed: 13 });
    assert.equal(store.getState().threads.list.countsAsOfSeq, 50n);
    assert.equal(store.getState().threads.list.nextCursor, null);
  });

  it('counts a terminal the tail brings while the first page is in flight, when the counts are older than it', async () => {
    let release!: (page: ThreadsResponse) => void;
    const pending = new Promise<ThreadsResponse>(resolve => {
      release = resolve;
    });
    const api = fakeApi({
      snapshot: async () => snapshot({ asOfSeq: 50n, threads: [thread({ id: 'main', parentId: null, agent: 'coordinator', createdSeq: 1n }), thread({ id: 'a', createdSeq: 9n, title: 'Review the list' })] }),
      threads: { list: async query => (query.q ? pending : { threads: [], nextCursor: null }) },
    });
    const store = createStore({ api, initialRoute: { key: 'threads', q: 'review' } });

    await dispatched(store, sessionCheck());
    await settle();
    await new Promise(resolve => setTimeout(resolve, SEARCH_DEBOUNCE_MS + 20));
    assert.equal(store.getState().threads.list.loading, true);

    // The thread of the set ends while the page is in flight; the page's counts were taken before that.
    store.dispatch(eventAction(event({ type: 'thread.completed', seq: 61n, threadId: 'a', payload: { summary: { text: 'done' } } })));
    release({ threads: [], nextCursor: null, counts: { active: 1, completed: 0, failed: 0, cancelled: 0 }, countsAsOfSeq: 50n });
    await settle();
    assert.deepEqual(store.getState().threads.list.counts, { active: 1, completed: 1, failed: 0, cancelled: 0 });
    assert.deepEqual(selectListThreads(store.getState()).map(t => t.id), ['a']);

    // The same terminal replayed changes nothing.
    store.dispatch(eventAction(event({ type: 'thread.completed', seq: 61n, threadId: 'a', payload: { summary: { text: 'done' } } })));
    assert.equal(store.getState().threads.list.counts?.completed, 1);
  });

  it('leaves a terminal the counts already hold alone: the Active page came after the thread ended, its row is not there, the tail delivers the terminal later', async () => {
    const api = fakeApi({
      snapshot: async () => snapshot({ asOfSeq: 50n, threads: [thread({ id: 'main', parentId: null, agent: 'coordinator', createdSeq: 1n }), thread({ id: 'a', createdSeq: 9n })] }),
      threads: { list: async () => ({ threads: [], nextCursor: null, counts: { active: 0, completed: 1, failed: 0, cancelled: 0 }, countsAsOfSeq: 61n }) },
    });
    const store = createStore({ api, initialRoute: { key: 'threads', status: 'active' } });

    await dispatched(store, sessionCheck());
    await settle();
    // The store still sees the thread active: the tail has not delivered the terminal yet.
    assert.deepEqual(selectListThreads(store.getState()).map(t => t.id), ['a']);

    store.dispatch(eventAction(event({ type: 'thread.completed', seq: 61n, threadId: 'a', payload: { summary: { text: 'done' } } })));
    assert.deepEqual(store.getState().threads.list.counts, { active: 0, completed: 1, failed: 0, cancelled: 0 });
    assert.deepEqual(selectListThreads(store.getState()), []);

    // A terminal above the stamp counts.
    store.dispatch(eventAction(event({ type: 'thread.started', seq: 62n, threadId: 'n', targetThreadId: 'main', payload: { agent: 'designer' } })));
    store.dispatch(eventAction(event({ type: 'thread.failed', seq: 63n, threadId: 'n', payload: { error: 'boom' } })));
    assert.deepEqual(store.getState().threads.list.counts, { active: 0, completed: 1, failed: 1, cancelled: 0 });
  });
});

describe('thread page data', () => {
  it('fetches a thread outside the snapshot window by id once, and keeps a 404 until a retry', async () => {
    resetSeq(1n);

    const calls: Calls = [];
    let answer: 'ok' | 'missing' = 'missing';
    const api = fakeApi(
      {
        snapshot: async () => snapshot({ asOfSeq: 20n }),
        threads: {
          get: async id => {
            if (answer === 'missing') {
              throw new ApiError(404, 'not_found', 'No such thread');
            }

            return { thread: thread({ id, agent: 'browser', createdSeq: 3n }), headless: false };
          },
        },
      },
      calls,
    );
    const store = createStore({ api, initialRoute: { key: 'thread', id: 'tx' } });

    await dispatched(store, sessionCheck());
    await settle();
    await settle();

    assert.equal(calls.filter(call => call.name === 'threads.get').length, 1);
    assert.deepEqual(store.getState().threads.lookup.tx, { loading: false, error: { status: 404, code: 'not_found', message: 'No such thread' } });

    // Coming back to the route does not ask again; the screen's retry does.
    store.dispatch(routeTo({ key: 'threads' }));
    store.dispatch(routeTo({ key: 'thread', id: 'tx' }));
    await settle();
    assert.equal(calls.filter(call => call.name === 'threads.get').length, 1);

    answer = 'ok';
    await dispatched(store, loadThread('tx'));
    assert.equal(store.getState().threads.byId.tx?.agent, 'browser');
    assert.equal(store.getState().threads.lookup.tx, undefined);

    // A thread the snapshot knows is never fetched.
    store.dispatch(routeTo({ key: 'thread', id: 'tx' }));
    await settle();
    assert.equal(calls.filter(call => call.name === 'threads.get').length, 2);
  });

  it('sends a composer message: the draft clears on success, stays with a toast on failure, one request at a time', async () => {
    resetSeq(1n);

    const calls: Calls = [];
    let resolveSend: (() => void) | null = null;
    let fail = false;
    const api = fakeApi(
      {
        snapshot: async () => snapshot({ asOfSeq: 20n, threads: [thread({ id: 't1' })] }),
        threads: {
          sendMessage: () =>
            new Promise((resolve, reject) => {
              resolveSend = () => (fail ? reject(new ApiError(409, 'thread_closed', 'The thread is no longer active')) : resolve({}));
            }),
        },
      },
      calls,
    );
    const store = createStore({ api, initialRoute: { key: 'thread', id: 't1' } });

    await dispatched(store, sessionCheck());
    await settle();

    store.dispatch(setComposerDraft('t1', 'hello'));

    const sending = dispatched(store, sendMessage('t1', 'hello'));

    assert.deepEqual(store.getState().ui.composerSending.t1, { draft: 'hello' });
    store.dispatch(sendMessage('t1', 'hello again'));
    assert.equal(calls.filter(call => call.name === 'threads.sendMessage').length, 1);

    resolveSend!();
    await sending;
    assert.equal(store.getState().ui.composerSending.t1, undefined);
    assert.equal(store.getState().ui.composerDrafts.t1, undefined);

    // The field stays editable while the message is on its way: what was
    // typed meanwhile is the next draft, not the sent one — it stays.
    store.dispatch(setComposerDraft('t1', 'second'));

    const typing = dispatched(store, sendMessage('t1', 'second'));

    store.dispatch(setComposerDraft('t1', 'third, still typing'));
    resolveSend!();
    await typing;
    assert.equal(store.getState().ui.composerSending.t1, undefined);
    assert.equal(store.getState().ui.composerDrafts.t1, 'third, still typing');

    store.dispatch(setComposerDraft('t1', 'later'));
    fail = true;

    const failing = dispatched(store, sendMessage('t1', 'later'));

    resolveSend!();
    await failing;
    assert.equal(store.getState().ui.composerSending.t1, undefined);
    assert.equal(store.getState().ui.composerDrafts.t1, 'later');
    assert.deepEqual(
      store.getState().ui.toasts.map(toast => [toast.title, toast.state]),
      [['Message not sent', 'err']],
    );
  });
});

describe('home overview', () => {
  const project = (id: string, updatedAt: Date, archived = false) => ({ id, title: id, slug: id, description: '', archived, createdAt: updatedAt, updatedAt });

  async function homeStore() {
    const api = fakeApi({
      snapshot: async () =>
        snapshot({
          asOfSeq: 50n,
          threads: [
            thread({ id: 'main', parentId: null, agent: 'coordinator' }),
            thread({ id: 'a', createdSeq: 7n, projectId: 'p1' }),
            thread({ id: 'b', createdSeq: 8n, projectId: 'p1' }),
            thread({ id: 'c', createdSeq: 9n }),
            thread({ id: 'old', createdSeq: 2n, status: 'completed', terminalSeq: 20n, title: 'Old one' }),
            thread({ id: 'last', createdSeq: 3n, status: 'failed', terminalSeq: 30n, title: 'Last one' }),
          ],
          projects: [project('p1', new Date(1000)), project('p2', new Date(3000)), project('p3', new Date(2000), true)],
        }),
    });
    const store = createStore({ api, initialRoute: { key: 'home' } });

    await dispatched(store, sessionCheck());
    await settle();

    return store;
  }

  it('counts the running threads per project and knows the thread that ended last', async () => {
    const store = await homeStore();

    // The main thread is reached from the shell, never among "Active threads".
    assert.equal(selectMainThread(store.getState())?.id, 'main');
    assert.deepEqual(store.getState().threads.byId.main && selectRunningCount(store.getState()), 3);
    assert.deepEqual(selectRunningCountByProject(store.getState()), { p1: 2 });
    assert.equal(selectLatestFinishedThread(store.getState())?.id, 'last');

    // A thread that ends now becomes the last one; its project count drops.
    const done = event({ seq: 51n, type: 'thread.completed', threadId: 'a', targetThreadId: 'main', payload: { title: 'A done', summary: { text: 's' }, description: 'd' } });

    store.dispatch(eventAction(done));
    assert.deepEqual(selectRunningCountByProject(store.getState()), { p1: 1 });
    assert.equal(selectLatestFinishedThread(store.getState())?.title, 'A done');
    assert.equal(selectLatestFinishedThread(store.getState())?.updatedAt, done.createdAt);

    // A late tail of its journal (allowed by the log) is not activity: the thread keeps the time of its terminal.
    store.dispatch(eventAction(event({ seq: 52n, type: 'session.turn', threadId: 'a', payload: { phase: 'completed' } })));
    assert.equal(store.getState().stream.lastSeq, 52n);
    assert.equal(selectLatestFinishedThread(store.getState())?.updatedAt, done.createdAt);
    assert.equal(store.getState().threads.byId.b.updatedAt.getTime(), 1_700_000_000_000);
    store.dispatch(eventAction(event({ seq: 53n, type: 'session.turn', threadId: 'b', payload: { phase: 'started' } })));
    assert.equal(store.getState().threads.byId.b.updatedAt.getTime(), 1_700_000_000_000 + 53_000);
  });

  it('lists the projects in work by recency, archived ones aside', async () => {
    const store = await homeStore();

    assert.deepEqual(
      selectActiveProjects(store.getState()).map(p => p.id),
      ['p2', 'p1'],
    );
    assert.equal(selectArchivedProjectCount(store.getState()), 1);
  });

  it('knows nothing has finished before any terminal event', async () => {
    const api = fakeApi({ snapshot: async () => snapshot({ asOfSeq: 50n, threads: [thread({ id: 'main', parentId: null })] }) });
    const store = createStore({ api, initialRoute: { key: 'home' } });

    await dispatched(store, sessionCheck());
    await settle();
    assert.equal(selectLatestFinishedThread(store.getState()), null);
    assert.deepEqual(selectRunningCountByProject(store.getState()), {});
  });
});

describe('agents screen', () => {
  async function agentsStore() {
    const api = fakeApi({
      snapshot: async () =>
        snapshot({
          asOfSeq: 50n,
          threads: [
            thread({ id: 'main', parentId: null, agent: 'coordinator' }),
            thread({ id: 'e1', createdSeq: 7n, agent: 'engineer' }),
            thread({ id: 'e2', createdSeq: 9n, agent: 'engineer' }),
            thread({ id: 'e0', createdSeq: 12n, agent: 'engineer', status: 'completed', terminalSeq: 20n }),
            thread({ id: 'b1', createdSeq: 8n, agent: 'browser' }),
          ],
          agents: [
            { name: 'engineer', description: 'code', icon: null, sdk: 'claude', tools: ['events'], agents: ['browser'], headless: false, notification: null, model: 'm', effort: 'high' },
            { name: 'browser', description: 'web', icon: null, sdk: 'claude', tools: [], agents: [], headless: true, notification: null, model: null, effort: null },
          ],
        }),
    });
    const store = createStore({ api, initialRoute: { key: 'agents', name: 'engineer' } });

    await dispatched(store, sessionCheck());
    await settle();

    return store;
  }

  it('counts the running threads per agent and lists an agent’s threads, active first, newest first', async () => {
    const store = await agentsStore();
    const selectThreads = makeSelectAgentThreads();

    // The root thread is not work in progress: the coordinator has no count.
    assert.deepEqual(selectRunningCountByAgent(store.getState()), { engineer: 2, browser: 1 });
    assert.deepEqual(
      selectThreads(store.getState(), 'engineer').map(t => t.id),
      ['e2', 'e1', 'e0'],
    );
    assert.deepEqual(selectThreads(store.getState(), 'gardener'), []);

    // The same answer while nothing changed; a thread ending moves it after the active ones.
    const before = selectThreads(store.getState(), 'engineer');

    assert.equal(selectThreads(store.getState(), 'engineer'), before);
    store.dispatch(eventAction(event({ seq: 51n, type: 'thread.completed', threadId: 'e2', targetThreadId: 'main', payload: { summary: { text: 's' } } })));
    assert.deepEqual(
      selectThreads(store.getState(), 'engineer').map(t => t.id),
      ['e1', 'e0', 'e2'],
    );
    assert.deepEqual(selectRunningCountByAgent(store.getState()), { engineer: 1, browser: 1 });

    // A thread the tail starts counts at once.
    store.dispatch(eventAction(event({ seq: 52n, type: 'thread.started', threadId: 'b2', targetThreadId: 'main', agentName: 'browser', payload: { agent: 'browser', title: 'x', headless: true, input: 'go' } })));
    assert.deepEqual(selectRunningCountByAgent(store.getState()), { engineer: 1, browser: 2 });
  });
});

describe('registry events', () => {
  const ISO = '2026-10-09T10:00:00.000Z';
  const LATER = '2026-10-09T12:00:00.000Z';

  it('keeps the projects of the snapshot up to date from project.* events', async () => {
    resetSeq(300n);

    const store = createStore({ api: fakeApi({ snapshot: async () => snapshot({ projects: [{ id: 'p1', title: 'One', slug: 'one', description: 'd', archived: false, createdAt: new Date(ISO), updatedAt: new Date(ISO) }] }) }), initialRoute: { key: 'home' } });

    await dispatched(store, sessionCheck());
    await settle();

    store.dispatch(eventAction(event({ type: 'project.created', actor: 'user', payload: { id: 'p2', title: 'Two', slug: 'two', description: 'd2', archived: false, createdAt: LATER, updatedAt: LATER } })));
    assert.deepEqual(selectActiveProjects(store.getState()).map(project => project.id), ['p2', 'p1']);

    store.dispatch(eventAction(event({ type: 'project.updated', threadId: 'main', payload: { id: 'p1', title: 'One renamed', slug: 'one', description: 'd', archived: false, createdAt: ISO, updatedAt: '2026-10-09T13:00:00.000Z' } })));
    assert.equal(store.getState().projects.byId.p1.title, 'One renamed');
    assert.deepEqual(selectActiveProjects(store.getState()).map(project => project.id), ['p1', 'p2']);

    store.dispatch(eventAction(event({ type: 'project.archived', threadId: 'main', payload: { id: 'p2', title: 'Two', slug: 'two', description: 'd2', archived: true, createdAt: LATER, updatedAt: LATER } })));
    assert.equal(selectArchivedProjectCount(store.getState()), 1);
    assert.deepEqual(store.getState().projects.ids, ['p1', 'p2']);

    // A record without its id is not folded in.
    const before = store.getState().projects;

    store.dispatch(eventAction(event({ type: 'project.updated', threadId: 'main', payload: { title: 'ghost' } })));
    assert.equal(store.getState().projects, before);
  });

  it('adds and drops scheduled tasks', async () => {
    resetSeq(320n);

    const store = createStore({ api: fakeApi(), initialRoute: { key: 'home' } });

    await dispatched(store, sessionCheck());
    await settle();

    const record = { id: 'k1', slug: 'backup', name: 'Backup', description: null, kind: 'command', cron: '0 3 * * *', at: null, note: null, command: 'pg_dump', cwd: null, timeoutMs: null, reportOnSuccess: false, createdBy: 'scheduler', createdAt: ISO, nextRunAt: LATER };

    store.dispatch(eventAction(event({ type: 'schedule.task.created', threadId: 'main', payload: record })));
    assert.deepEqual(store.getState().schedule.ids, ['k1']);
    assert.equal(store.getState().schedule.tasks.k1.nextRunAt?.toISOString(), LATER);

    store.dispatch(eventAction(event({ type: 'schedule.task.cancelled', actor: 'system', payload: { ...record, reason: 'consumed' } })));
    assert.deepEqual(store.getState().schedule.ids, []);
    assert.equal(store.getState().schedule.tasks.k1, undefined);
  });

  it('flips the publication of an app and learns a folder the snapshot did not list', async () => {
    resetSeq(340n);

    const store = createStore({ api: fakeApi({ snapshot: async () => snapshot({ apps: { apps: [{ path: 'b/tracker', name: 'Tracker', description: null, manifestError: null, slug: null }], publicAppsBase: 'https://apps.example' } }) }), initialRoute: { key: 'home' } });

    await dispatched(store, sessionCheck());
    await settle();

    store.dispatch(eventAction(event({ type: 'app.published', actor: 'user', payload: { path: 'b/tracker', slug: 'tracker', name: 'Tracker', description: null } })));
    assert.equal(store.getState().apps.items[0].slug, 'tracker');

    // The same publication again is the same state.
    const published = store.getState().apps;

    store.dispatch(eventAction(event({ type: 'app.published', actor: 'user', payload: { path: 'b/tracker', slug: 'tracker', name: 'Tracker', description: null } })));
    assert.equal(store.getState().apps, published);

    store.dispatch(eventAction(event({ type: 'app.published', actor: 'user', payload: { path: 'a/new', slug: 'new-app', name: 'New', description: 'fresh' } })));
    assert.deepEqual(store.getState().apps.items.map(item => [item.path, item.slug, item.name]), [['a/new', 'new-app', 'New'], ['b/tracker', 'tracker', 'Tracker']]);

    store.dispatch(eventAction(event({ type: 'app.unpublished', actor: 'user', payload: { path: 'b/tracker', slug: 'tracker' } })));
    assert.equal(store.getState().apps.items[1].slug, null);
    assert.equal(store.getState().apps.items[1].name, 'Tracker');
  });

  it('publishing a folder the snapshot saw with a broken manifest takes the validated manifest and drops the error', async () => {
    resetSeq(350n);

    const store = createStore({ api: fakeApi({ snapshot: async () => snapshot({ apps: { apps: [{ path: 'b/tracker', name: null, description: null, manifestError: 'name is required', slug: null }], publicAppsBase: 'https://apps.example' } }) }), initialRoute: { key: 'home' } });

    await dispatched(store, sessionCheck());
    await settle();

    store.dispatch(eventAction(event({ type: 'app.published', actor: 'user', payload: { path: 'b/tracker', slug: 'tracker', name: 'Tracker', description: 'fixed' } })));
    assert.deepEqual(store.getState().apps.items, [{ path: 'b/tracker', slug: 'tracker', name: 'Tracker', description: 'fixed', manifestError: null }]);
  });

  it('follows a connection through its life by connectionId; events without one are left alone', async () => {
    resetSeq(360n);

    const store = createStore({ api: fakeApi(), initialRoute: { key: 'home' } });

    await dispatched(store, sessionCheck());
    await settle();

    store.dispatch(eventAction(event({ type: 'connection.pending', actor: 'system', targetThreadId: 't1', payload: { connectionId: 'c1', server: 'notion', account: 'default', name: 'Notion', status: 'pending', identity: null, scope: null, threadId: 't1', createdAt: ISO, updatedAt: ISO } })));
    assert.deepEqual(selectConnections(store.getState()).map(connection => [connection.id, connection.status]), [['c1', 'pending']]);

    // completed carries the row as the flow left it: scope and the exact updatedAt come from it.
    store.dispatch(eventAction(event({ type: 'connection.completed', actor: 'system', targetThreadId: 't1', payload: { connectionId: 'c1', server: 'notion', account: 'default', name: 'Notion', status: 'connected', identity: 'me@example.com', scope: 'read write', threadId: 't1', createdAt: ISO, updatedAt: LATER } })));
    assert.equal(store.getState().connections.byId.c1.status, 'connected');
    assert.equal(store.getState().connections.byId.c1.identity, 'me@example.com');
    assert.equal(store.getState().connections.byId.c1.scope, 'read write');
    assert.equal(store.getState().connections.byId.c1.updatedAt.toISOString(), LATER);

    // A consent that landed on an already connected account completes that row — unknown to the snapshot, it joins whole.
    store.dispatch(eventAction(event({ type: 'connection.completed', actor: 'system', targetThreadId: 't1', payload: { connectionId: 'c2', server: 'notion', account: 'work', name: 'Work', status: 'connected', identity: 'me@example.com', scope: 'read', threadId: 't1', createdAt: ISO, updatedAt: LATER, alreadyConnected: true, requestedAccount: 'default' } })));
    assert.deepEqual(store.getState().connections.ids, ['c1', 'c2']);

    // A completed recorded before the row was carried patches the status and identity, the time is the event's.
    store.dispatch(eventAction(event({ type: 'connection.reauthorization_required', actor: 'system', targetThreadId: 't1', payload: { connectionId: 'c2', server: 'notion', account: 'work', name: 'Work', error: 'token revoked' } })));

    const patched = event({ type: 'connection.completed', actor: 'system', targetThreadId: 't1', payload: { connectionId: 'c2', server: 'notion', account: 'work', name: 'Work', identity: null } });

    store.dispatch(eventAction(patched));
    assert.equal(store.getState().connections.byId.c2.status, 'connected');
    assert.equal(store.getState().connections.byId.c2.identity, 'me@example.com');
    assert.equal(store.getState().connections.byId.c2.scope, 'read');
    assert.equal(store.getState().connections.byId.c2.updatedAt, patched.createdAt);

    store.dispatch(eventAction(event({ type: 'connection.renamed', actor: 'system', targetThreadId: 't1', payload: { connectionId: 'c1', server: 'notion', account: 'default', name: 'Work Notion', previousName: 'Notion' } })));
    assert.equal(store.getState().connections.byId.c1.displayName, 'Work Notion');

    store.dispatch(eventAction(event({ type: 'connection.reauthorization_required', actor: 'system', targetThreadId: 't1', payload: { connectionId: 'c1', server: 'notion', account: 'default', name: 'Work Notion', error: 'token revoked' } })));
    assert.deepEqual(selectConnectionsNeedingAction(store.getState()).map(connection => connection.id), ['c1']);

    // An old-style event names the account only: nothing to key it by.
    const before = store.getState().connections;

    store.dispatch(eventAction(event({ type: 'connection.completed', actor: 'system', targetThreadId: 't1', payload: { server: 'notion', account: 'default', name: 'Work Notion' } })));
    assert.equal(store.getState().connections, before);

    store.dispatch(eventAction(event({ type: 'connection.disconnected', actor: 'system', targetThreadId: 't1', payload: { connectionId: 'c1', server: 'notion', account: 'default', name: 'Work Notion', reason: 'disconnected' } })));
    assert.deepEqual(store.getState().connections.ids, ['c2']);
    assert.equal(store.getState().connections.byId.c1, undefined);
  });
});

describe('thread commands', () => {
  it('sends a stop or a cancel once at a time; the button frees on the answer, a failure reports', async () => {
    resetSeq(1n);

    const calls: Calls = [];
    const pending: (() => void)[] = [];
    let fail = false;
    const command = () =>
      new Promise<unknown>((resolve, reject) => {
        pending.push(() => (fail ? reject(new ApiError(409, 'thread_closed', 'The thread is no longer active')) : resolve({})));
      });
    const answer = () => {
      for (const settle of pending.splice(0)) {
        settle();
      }
    };
    const api = fakeApi({ snapshot: async () => snapshot({ asOfSeq: 20n, threads: [thread({ id: 't1' })] }), threads: { interrupt: command, cancel: command } }, calls);
    const store = createStore({ api, initialRoute: { key: 'thread', id: 't1' } });

    await dispatched(store, sessionCheck());
    await settle();

    const stopping = dispatched(store, commandThread('t1', 'interrupt'));

    assert.deepEqual(store.getState().ui.threadCommands.t1, { interrupt: true });
    store.dispatch(commandThread('t1', 'interrupt'));
    assert.equal(calls.filter(call => call.name === 'threads.interrupt').length, 1);

    // A cancel is a different command: it goes while the stop is in flight.
    const cancelling = dispatched(store, commandThread('t1', 'cancel', 'enough'));

    assert.deepEqual(store.getState().ui.threadCommands.t1, { interrupt: true, cancel: true });
    assert.deepEqual(calls.find(call => call.name === 'threads.cancel')?.args, ['t1', 'enough']);

    answer();
    await stopping;
    await cancelling;
    assert.equal(store.getState().ui.threadCommands.t1, undefined);
    assert.deepEqual(store.getState().ui.toasts, []);

    fail = true;

    const failing = dispatched(store, commandThread('t1', 'cancel'));

    answer();
    await failing;
    assert.equal(store.getState().ui.threadCommands.t1, undefined);
    assert.deepEqual(
      store.getState().ui.toasts.map(toast => [toast.title, toast.desc]),
      [['Couldn’t cancel the thread', 'The thread is no longer active']],
    );
  });
});
