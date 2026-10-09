// The store as a whole: real reducers and middleware, a fake Api. Covers
// the start-up cascade (session → snapshot → route data), sign-in and
// sign-out, the threads and feed folds of events (idempotent by seq), the
// stale-answer rule of the handlers.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Thread } from '../../core/contract.ts';
import type { Api } from '../lib/api/index.ts';
import { ApiError } from '../lib/api/index.ts';
import type { StoreEnhancer } from 'redux';
import { createStore } from './index.ts';
import type { AppRoute } from '../lib/router/routes.ts';
import type { Action, AppStore } from './index.ts';
import { eventAction } from './events.ts';
import { routeTo } from './router/actions.ts';
import { login, logout, sessionCheck, sessionLost } from './session/actions.ts';
import { loadThread, loadThreadEvents, loadThreads, sendMessage } from './threads/actions.ts';
import { setComposerDraft } from './ui/actions.ts';
import { hasLoadedPage, selectKnownAgents, selectLatestFinishedThread, selectListThreads, selectRunningCount, selectRunningCountByProject, selectVisibleListThreads } from './threads/selectors.ts';
import { selectActiveProjects, selectArchivedProjectCount } from './projects/selectors.ts';
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
    assert.deepEqual(calls.at(-1)?.args, [{ status: 'failed', limit: 50 }]);
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
      ['a', 'b', 'old', 'main'],
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

  it('narrows the visible rows by the route’s agent and search without reloading', async () => {
    const calls: Calls = [];
    const store = await listStore({ key: 'threads' }, null, calls);

    store.dispatch(eventAction(event({ type: 'thread.started', seq: 60n, threadId: 'n', targetThreadId: 'main', payload: { agent: 'designer', title: 'Slug scheme' } })));

    await dispatched(store, routeTo({ key: 'threads', agent: 'designer' }, { replace: true }));
    await settle();
    assert.deepEqual(selectVisibleListThreads(store.getState()).map(t => t.id), ['n']);

    await dispatched(store, routeTo({ key: 'threads', q: 'SLUG' }, { replace: true }));
    await settle();
    assert.deepEqual(selectVisibleListThreads(store.getState()).map(t => t.id), ['n']);
    assert.equal(calls.filter(call => call.name === 'threads.list').length, 1);
    assert.deepEqual(selectKnownAgents(store.getState()), ['coordinator', 'designer', 'engineer']);
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

    assert.deepEqual(selectRunningCountByProject(store.getState()), { p1: 2 });
    assert.equal(selectLatestFinishedThread(store.getState())?.id, 'last');

    // A thread that ends now becomes the last one; its project count drops.
    store.dispatch(eventAction(event({ seq: 51n, type: 'thread.completed', threadId: 'a', targetThreadId: 'main', payload: { title: 'A done', summary: { text: 's' }, description: 'd' } })));
    assert.deepEqual(selectRunningCountByProject(store.getState()), { p1: 1 });
    assert.equal(selectLatestFinishedThread(store.getState())?.title, 'A done');
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
