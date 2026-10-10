// The store as a whole: real reducers and middleware, a fake Api. Covers
// the start-up cascade (session → snapshot → route data), sign-in and
// sign-out, the threads and feed folds of events (idempotent by seq), the
// stale-answer rule of the handlers.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Thread } from '../../core/contract.ts';
import type { Api } from '../lib/api/index.ts';
import type { AppsResponse, ProjectView, ThreadsResponse } from '../../api/contract.ts';
import { ApiError } from '../lib/api/index.ts';
import type { StoreEnhancer } from 'redux';
import { createStore } from './index.ts';
import type { AppRoute } from '../lib/router/routes.ts';
import type { Action, AppStore } from './index.ts';
import { eventAction } from './events.ts';
import { routeTo, tabVisible } from './router/actions.ts';
import { loadApps, publishApp, unpublishApp } from './apps/actions.ts';
import { selectAppCall, selectAppPublish } from './apps/selectors.ts';
import { login, logout, requestConsoleCode, saveSettings, sessionCheck, sessionLost } from './session/actions.ts';
import { selectOperatorName } from './session/selectors.ts';
import { commandThread, loadThread, loadThreadEvents, loadThreads, sendMessage } from './threads/actions.ts';
import { setComposerDraft } from './ui/actions.ts';
import { hasLoadedPage, makeSelectAgentThreads, makeSelectProjectThreads, selectActiveCountIn, selectKnownAgents, selectLatestFinishedThread, selectListThreads, selectMainThread, selectRunningCount, selectRunningCountByAgent, selectRunningCountByProject } from './threads/selectors.ts';
import { SEARCH_DEBOUNCE_MS } from './threads/handlers.ts';
import { createProject, setProjectArchived, updateProject } from './projects/actions.ts';
import { selectActiveProjects, selectArchivedProjectCount, selectArchivedProjects, selectProjectCreate, selectProjectEdit, selectProjectFlagging } from './projects/selectors.ts';
import { selectConnections, selectConnectionsNeedingAction } from './connections/selectors.ts';
import { makeSelectThreadEvents } from './feed/selectors.ts';
import { snapshotLoad, snapshotLoadDone } from './stream/actions.ts';
import { makeSelectLastMessage } from '../features/thread-list/selectors.ts';
import { selectThreadState } from './sessions/selectors.ts';
import { ME, event, resetSeq, snapshot, thread } from './fixtures.ts';

type Calls = { name: string; args: unknown[] }[];

const ISO_NOW = '2026-10-09T10:00:00.000Z';

type ApiOverrides = Omit<Partial<Api>, 'threads' | 'workspace' | 'files' | 'settings' | 'llmRequests' | 'secretRequests' | 'projects' | 'apps'> & { threads?: Partial<Api['threads']>; settings?: Partial<Api['settings']>; projects?: Partial<Api['projects']>; apps?: Partial<Api['apps']> };

// The file area, the stored files' facts, the model requests and the secret
// requests are Query, not the store: handlers never call them.
const LLM_REQUESTS: Api['llmRequests'] = { list: async () => ({ requests: [] }) };

const FILES: Api['files'] = { meta: async fileId => ({ file: { fileId, name: null, contentType: null, sizeBytes: null, width: null, height: null } }) };

const SECRET_REQUESTS: Api['secretRequests'] = {
  get: async id => ({ request: { id, kind: 'oauth-client', server: 'notion', fields: [] } }),
  provision: async () => ({ ok: true }),
};

const WORKSPACE: Api['workspace'] = {
  node: async () => ({ kind: 'dir', path: '', directories: [], folders: [], files: [] }),
  text: async () => '',
};

function fakeApi(overrides: ApiOverrides = {}, calls: Calls = []): Api {
  const wrap =
    <A extends unknown[], T>(name: string, impl: (...args: A) => Promise<T>) =>
    (...args: A) => {
      calls.push({ name, args });

      return impl(...args);
    };
  const base: Omit<Api, 'threads' | 'workspace' | 'files' | 'settings' | 'llmRequests' | 'secretRequests' | 'projects' | 'apps'> = {
    me: async () => ME,
    auth: async () => ME,
    consoleCode: async () => null,
    logout: async () => ({ ok: true as const }),
    snapshot: async () => snapshot(),
    ...overrides,
  };
  const apps: Api['apps'] = {
    list: async () => ({ apps: [], publicAppsBase: 'https://apps.example' }),
    publish: async input => ({ path: input.path, slug: input.slug }),
    unpublish: async input => ({ path: input.path ?? '', slug: input.slug ?? 'slug' }),
    ...overrides.apps,
  };
  // Every answer of a save is newer than the fixtures' snapshot and events.
  let answerSeq = 1_000n;
  const settings: Api['settings'] = {
    update: async patch => ({ settings: { workspaceName: patch.workspaceName ?? ME.workspaceName, operatorName: patch.operatorName ?? ME.operatorName }, seq: answerSeq++ }),
    ...overrides.settings,
  };
  const projectRow = (id: string, patch: Partial<ProjectView> = {}): ProjectView => ({ id, title: 'Project', slug: 'project', description: 'd', archived: false, archivedAt: null, createdAt: new Date(ISO_NOW), updatedAt: new Date(ISO_NOW), ...patch });
  const projects: Api['projects'] = {
    create: async input => ({ project: projectRow('new', { ...input }), adopted: false }),
    update: async (id, patch) => ({ project: projectRow(id, { title: patch.title ?? 'Project', description: patch.description ?? 'd' }) }),
    archive: async id => ({ project: projectRow(id, { archived: true }) }),
    unarchive: async id => ({ project: projectRow(id, { archived: false }) }),
    ...overrides.projects,
  };
  const threads: Api['threads'] = {
    list: async () => ({ threads: [], nextCursor: null }),
    get: async () => ({ thread: thread({ id: 't1' }) }),
    events: async () => ({ events: [], nextCursor: null }),
    sendMessage: async () => ({}),
    interrupt: async () => ({}),
    cancel: async () => ({}),
    ...overrides.threads,
  };

  return {
    me: wrap('me', base.me),
    auth: wrap('auth', base.auth),
    consoleCode: wrap('consoleCode', base.consoleCode),
    logout: wrap('logout', base.logout),
    snapshot: wrap('snapshot', base.snapshot),
    settings: { update: wrap('settings.update', settings.update) },
    apps: { list: wrap('apps.list', apps.list), publish: wrap('apps.publish', apps.publish), unpublish: wrap('apps.unpublish', apps.unpublish) },
    projects: {
      create: wrap('projects.create', projects.create),
      update: wrap('projects.update', projects.update),
      archive: wrap('projects.archive', projects.archive),
      unarchive: wrap('projects.unarchive', projects.unarchive),
    },
    threads: {
      list: wrap('threads.list', threads.list),
      get: wrap('threads.get', threads.get),
      events: wrap('threads.events', threads.events),
      sendMessage: wrap('threads.sendMessage', threads.sendMessage),
      interrupt: wrap('threads.interrupt', threads.interrupt),
      cancel: wrap('threads.cancel', threads.cancel),
    },
    workspace: WORKSPACE,
    files: FILES,
    llmRequests: LLM_REQUESTS,
    secretRequests: SECRET_REQUESTS,
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

  it('the word "console" asks the server to print a code; the field says so until the next attempt', async () => {
    const calls: Calls = [];
    let printing: (() => void) | null = null;
    let refuse = false;
    const api = fakeApi(
      {
        me: async () => {
          throw new ApiError(401, 'unauthorized', 'No valid session');
        },
        auth: async () => {
          throw new ApiError(401, 'invalid_code', 'The code is invalid or expired');
        },
        consoleCode: () =>
          new Promise<null>((resolve, reject) => {
            printing = () => (refuse ? reject(new ApiError(429, 'rate_limited', 'A login code was printed moments ago')) : resolve(null));
          }),
      },
      calls,
    );
    const store = createStore({ api, initialRoute: { key: 'login', next: '/apps/notes' } });

    await dispatched(store, sessionCheck());
    assert.equal(store.getState().session.status, 'anonymous');

    // One request at a time: the second press waits for the answer.
    const first = dispatched(store, requestConsoleCode());

    assert.deepEqual(store.getState().session.login, { request: { kind: 'console-code' }, error: null, codePrinted: false });
    await dispatched(store, requestConsoleCode());
    await dispatched(store, login('K7QM2X'));
    assert.equal(calls.filter(call => call.name === 'consoleCode').length, 1);
    assert.equal(calls.filter(call => call.name === 'auth').length, 0);

    printing!();
    await first;
    assert.deepEqual(store.getState().session.login, { request: null, error: null, codePrinted: true });
    assert.equal(store.getState().session.status, 'anonymous');

    // A wrong code keeps the hint (the code is still in the log); the next
    // request or sign-in starts over.
    await dispatched(store, login('WRONG'));
    assert.deepEqual(store.getState().session.login, { request: null, error: { status: 401, code: 'invalid_code', message: 'The code is invalid or expired' }, codePrinted: true });

    refuse = true;

    const second = dispatched(store, requestConsoleCode());

    assert.deepEqual(store.getState().session.login, { request: { kind: 'console-code' }, error: null, codePrinted: false });
    printing!();
    await second;
    assert.deepEqual(store.getState().session.login, { request: null, error: { status: 429, code: 'rate_limited', message: 'A login code was printed moments ago' }, codePrinted: false });
    assert.deepEqual(store.getState().router.route, { key: 'login', next: '/apps/notes' });
  });

  // The form is reset by a lost session (a stale 401 of the session before
  // can land while the operator is already on the form) and a new request
  // goes out while the old call is still in flight: the old answer — a
  // printed code, a refusal, a session, a wrong code — is for a request the
  // store no longer waits for and must neither word nor unblock the form
  // of the new one.
  it('an answer of a request that outlived a lost session is dropped; the request sent after keeps waiting', async () => {
    const calls: Calls = [];
    const printing: { resolve: () => void; reject: (error: Error) => void }[] = [];
    const checking: { resolve: () => void; reject: (error: Error) => void }[] = [];
    const api = fakeApi(
      {
        me: async () => {
          throw new ApiError(401, 'unauthorized', 'No valid session');
        },
        auth: () =>
          new Promise((resolve, reject) => {
            checking.push({ resolve: () => resolve(ME), reject });
          }),
        consoleCode: () =>
          new Promise<null>((resolve, reject) => {
            printing.push({ resolve: () => resolve(null), reject });
          }),
      },
      calls,
    );
    const store = createStore({ api, initialRoute: { key: 'login', next: '/apps/notes' } });
    const authCalls = () => calls.filter(call => call.name === 'auth').length;
    const waiting = { request: { kind: 'console-code' }, error: null, codePrinted: false };

    await dispatched(store, sessionCheck());

    // A printed code of the session before: the new request keeps waiting,
    // a sign-in meanwhile is still dropped, the hint comes with B's answer.
    const a = dispatched(store, requestConsoleCode());

    store.dispatch(sessionLost());
    assert.deepEqual(store.getState().session.login, { request: null, error: null, codePrinted: false });

    const b = dispatched(store, requestConsoleCode());

    assert.deepEqual(store.getState().session.login, waiting);
    assert.equal(printing.length, 2);
    printing[0]!.resolve();
    await a;
    assert.deepEqual(store.getState().session.login, waiting);
    await dispatched(store, login('K7QM2X'));
    assert.equal(authCalls(), 0);
    printing[1]!.resolve();
    await b;
    assert.deepEqual(store.getState().session.login, { request: null, error: null, codePrinted: true });

    // A refusal of the session before: the same.
    const c = dispatched(store, requestConsoleCode());

    store.dispatch(sessionLost());

    const d = dispatched(store, requestConsoleCode());

    assert.equal(printing.length, 4);
    printing[2]!.reject(new ApiError(429, 'rate_limited', 'A login code was printed moments ago'));
    await c;
    assert.deepEqual(store.getState().session.login, waiting);
    await dispatched(store, login('K7QM2X'));
    assert.equal(authCalls(), 0);
    printing[3]!.resolve();
    await d;
    assert.deepEqual(store.getState().session.login, { request: null, error: null, codePrinted: true });

    // A wrong code of the session before lands on an idle form: no error.
    const e = dispatched(store, login('OLD'));

    store.dispatch(sessionLost());
    assert.equal(checking.length, 1);
    checking[0]!.reject(new ApiError(401, 'invalid_code', 'The code is invalid or expired'));
    await e;
    assert.deepEqual(store.getState().session.login, { request: null, error: null, codePrinted: false });
    assert.equal(store.getState().session.status, 'anonymous');

    // A session of the sign-in before, answered while the next code is being
    // checked: not this request — the store stays with the one in flight.
    const f = dispatched(store, login('OLD'));

    store.dispatch(sessionLost());

    const g = dispatched(store, login('NEW'));

    assert.equal(checking.length, 3);
    checking[1]!.resolve();
    await f;
    assert.equal(store.getState().session.status, 'anonymous');
    assert.deepEqual(store.getState().session.login, { request: { kind: 'sign-in' }, error: null, codePrinted: false });
    checking[2]!.resolve();
    await g;
    await settle();
    assert.equal(store.getState().session.status, 'signed-in');
    assert.deepEqual(store.getState().session.login, { request: null, error: null, codePrinted: false });
    assert.equal(store.getState().stream.asOfSeq, 100n);
    assert.deepEqual(store.getState().router.route, { key: 'login', next: '/apps/notes' });
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

  it('follows the names of Settings changed elsewhere: settings.updated replaces both names of me', async () => {
    const store = createStore({ api: fakeApi(), initialRoute: { key: 'settings' } });

    // Nobody signed in yet: nothing to update.
    store.dispatch(eventAction(event({ type: 'settings.updated', actor: 'user', payload: { workspaceName: 'Home', operatorName: 'Vladimir' } })));
    assert.equal(store.getState().session.me, null);

    await dispatched(store, sessionCheck());
    await settle();
    assert.deepEqual([store.getState().session.me?.workspaceName, selectOperatorName(store.getState())], [ME.workspaceName, null]);

    // The tail runs ahead of the snapshot's stamp (100): an event within
    // the stamp is what the snapshot already told.
    store.dispatch(eventAction(event({ seq: 100n, type: 'settings.updated', actor: 'user', payload: { workspaceName: 'Within', operatorName: 'Within' } })));
    assert.deepEqual([store.getState().session.me?.workspaceName, selectOperatorName(store.getState())], [ME.workspaceName, null]);
    store.dispatch(eventAction(event({ seq: 101n, type: 'settings.updated', actor: 'user', payload: { workspaceName: 'Home', operatorName: 'Vladimir' } })));
    assert.deepEqual([store.getState().session.me?.workspaceName, selectOperatorName(store.getState())], ['Home', 'Vladimir']);
    assert.equal(store.getState().session.me?.userId, ME.userId, 'the rest of me is kept');

    // Cleared on another device: the event carries the group's title and no operator.
    store.dispatch(eventAction(event({ seq: 102n, type: 'settings.updated', actor: 'user', payload: { workspaceName: 'Group', operatorName: null } })));
    assert.deepEqual([store.getState().session.me?.workspaceName, selectOperatorName(store.getState())], ['Group', null]);
    // The in-flight and accepted counters of the cards are not the event's business.
    assert.deepEqual(store.getState().session.settingsSaving, { workspaceName: false, operatorName: false });
    assert.deepEqual(store.getState().session.settingsSaved, { workspaceName: 0, operatorName: 0 });
  });

  it('saves the names of Settings one field at a time: me follows the answer, a toast confirms', async () => {
    const calls: Calls = [];
    const api = fakeApi({}, calls);
    const store = createStore({ api, initialRoute: { key: 'settings' } });

    await dispatched(store, sessionCheck());
    await settle();
    assert.equal(selectOperatorName(store.getState()), null);

    const saving = store.dispatch(saveSettings({ operatorName: ' Vladimir ' }));

    assert.deepEqual(store.getState().session.settingsSaving, { workspaceName: false, operatorName: true });
    // A second press of the same card waits; the other card is free.
    await dispatched(store, saveSettings({ operatorName: 'Other' }));
    assert.equal(calls.filter(call => call.name === 'settings.update').length, 1);
    await saving;

    assert.deepEqual(store.getState().session.settingsSaving, { workspaceName: false, operatorName: false });
    assert.equal(selectOperatorName(store.getState()), ' Vladimir ');
    assert.equal(store.getState().session.me?.workspaceName, 'Workspace');
    assert.deepEqual(
      store.getState().ui.toasts.map(toast => [toast.title, toast.desc, toast.state]),
      [['Saved', 'Your name: “ Vladimir ”', 'done']],
    );

    // Clearing: the answer carries the fallback (the group's title) — the
    // toast says "cleared", not the fallback.
    await dispatched(store, saveSettings({ workspaceName: null }));
    assert.equal(store.getState().session.me?.workspaceName, 'Workspace');
    assert.equal(store.getState().ui.toasts.at(-1)?.desc, 'Workspace name cleared');

    // An empty patch is not a call.
    await dispatched(store, saveSettings({}));
    assert.equal(calls.filter(call => call.name === 'settings.update').length, 2);
  });

  it('applies an answer only ahead of the names it holds: a late answer of one card keeps the other card\'s name', async () => {
    // Both cards save at once; the answer of the first (workspace, seq 101)
    // arrives after the second (operator, seq 102) — each answer carries
    // both names as of its own event.
    const answers: ((settings: { workspaceName: string | null; operatorName: string | null }, seq: bigint) => void)[] = [];
    const api = fakeApi({ settings: { update: () => new Promise(resolve => answers.push((settings, seq) => resolve({ settings, seq }))) } });
    const store = createStore({ api, initialRoute: { key: 'settings' } });

    await dispatched(store, sessionCheck());
    await settle();

    const first = store.dispatch(saveSettings({ workspaceName: 'Personal' }));
    const second = store.dispatch(saveSettings({ operatorName: 'Vladimir' }));

    assert.deepEqual(store.getState().session.settingsSaving, { workspaceName: true, operatorName: true });
    answers[1]!({ workspaceName: 'Personal', operatorName: 'Vladimir' }, 102n);
    await second;
    assert.deepEqual(store.getState().session.settingsSaved, { workspaceName: 0, operatorName: 1 });
    answers[0]!({ workspaceName: 'Personal', operatorName: null }, 101n);
    await first;

    assert.equal(store.getState().session.me?.workspaceName, 'Personal');
    assert.equal(selectOperatorName(store.getState()), 'Vladimir');
    assert.deepEqual(store.getState().session.settingsSaving, { workspaceName: false, operatorName: false });
    assert.deepEqual(store.getState().session.settingsSaved, { workspaceName: 1, operatorName: 1 });
  });

  it('hydrates the names of me from the snapshot: a change between /me and the stamp is not lost', async () => {
    // Tab A reads /me (Workspace); tab B saves New — the event commits
    // before A's snapshot is stamped — so A's snapshot carries New under a
    // stamp that includes the event, and the tail from the stamp never
    // brings it again.
    const api = fakeApi({ snapshot: async () => snapshot({ asOfSeq: 50n, me: { ...ME, workspaceName: 'New', operatorName: 'Vladimir' } }) });
    const store = createStore({ api, initialRoute: { key: 'settings' } });

    await dispatched(store, sessionCheck());
    await settle();
    assert.deepEqual([store.getState().session.me?.workspaceName, selectOperatorName(store.getState())], ['New', 'Vladimir']);
    assert.equal(store.getState().session.me?.userId, ME.userId);
    assert.deepEqual(store.getState().session.settingsSaved, { workspaceName: 0, operatorName: 0 });

    // A snapshot stamped before names the tab already holds (a Retry
    // answering late) does not put them back — the tail from its stamp
    // brings the event again anyway; one stamped at or after them applies.
    store.dispatch(eventAction(event({ seq: 60n, type: 'settings.updated', actor: 'user', payload: { workspaceName: 'Newer', operatorName: null } })));
    store.dispatch(snapshotLoadDone(snapshot({ asOfSeq: 55n, me: { ...ME, workspaceName: 'New', operatorName: 'Vladimir' } })));
    assert.deepEqual([store.getState().session.me?.workspaceName, selectOperatorName(store.getState())], ['Newer', null]);
    store.dispatch(snapshotLoadDone(snapshot({ asOfSeq: 60n, me: { ...ME, workspaceName: 'Newest', operatorName: null } })));
    assert.equal(store.getState().session.me?.workspaceName, 'Newest');
  });

  it('a late answer of a save does not put back a name a newer event replaced', async () => {
    // Tab A saves A: the server commits and journals it (seq 101) while the
    // HTTP answer lags; tab B saves B (seq 102); A's tail brings both events
    // in order, then A's answer lands — as of 101, behind the names held as
    // of 102: it completes the save (the counter moves, the toast shows)
    // and leaves the names alone.
    let answer!: (reply: { settings: { workspaceName: string | null; operatorName: string | null }; seq: bigint }) => void;
    const api = fakeApi({ settings: { update: () => new Promise(resolve => { answer = resolve; }) } });
    const store = createStore({ api, initialRoute: { key: 'settings' } });

    await dispatched(store, sessionCheck());
    await settle();

    const late = store.dispatch(saveSettings({ workspaceName: 'A' }));

    store.dispatch(eventAction(event({ seq: 101n, type: 'settings.updated', actor: 'user', payload: { workspaceName: 'A', operatorName: null } })));
    store.dispatch(eventAction(event({ seq: 102n, type: 'settings.updated', actor: 'user', payload: { workspaceName: 'B', operatorName: null } })));
    assert.equal(store.getState().session.me?.workspaceName, 'B');
    answer({ settings: { workspaceName: 'A', operatorName: null }, seq: 101n });
    await late;

    assert.equal(store.getState().session.me?.workspaceName, 'B');
    assert.deepEqual(store.getState().session.settingsSaving, { workspaceName: false, operatorName: false });
    assert.deepEqual(store.getState().session.settingsSaved, { workspaceName: 1, operatorName: 0 });
    assert.equal(store.getState().ui.toasts.at(-1)?.desc, 'Workspace name: “A”');

    // The answer ahead of its own event applies; the event then changes
    // nothing more, and a newer one moves the names on.
    const early = store.dispatch(saveSettings({ workspaceName: 'C' }));

    answer({ settings: { workspaceName: 'C', operatorName: null }, seq: 103n });
    await early;
    assert.equal(store.getState().session.me?.workspaceName, 'C');
    store.dispatch(eventAction(event({ seq: 103n, type: 'settings.updated', actor: 'user', payload: { workspaceName: 'C', operatorName: null } })));
    assert.equal(store.getState().session.me?.workspaceName, 'C');
    store.dispatch(eventAction(event({ seq: 104n, type: 'settings.updated', actor: 'user', payload: { workspaceName: 'D', operatorName: 'Vladimir' } })));
    assert.deepEqual([store.getState().session.me?.workspaceName, selectOperatorName(store.getState())], ['D', 'Vladimir']);
    assert.deepEqual(store.getState().session.settingsSaved, { workspaceName: 2, operatorName: 0 });
  });

  it('says "cleared" for the blank string the form sends, whatever fallback the answer carries', async () => {
    // The server reads a blank name as "clear" and answers the group's title.
    let seq = 1_000n;
    const api = fakeApi({
      settings: {
        update: async patch => ({ settings: { workspaceName: patch.workspaceName?.trim() ? patch.workspaceName.trim() : 'Group', operatorName: patch.operatorName?.trim() || null }, seq: seq++ }),
      },
    });
    const store = createStore({ api, initialRoute: { key: 'settings' } });

    await dispatched(store, sessionCheck());
    await settle();

    await dispatched(store, saveSettings({ workspaceName: '' }));
    assert.equal(store.getState().session.me?.workspaceName, 'Group');
    assert.equal(store.getState().ui.toasts.at(-1)?.desc, 'Workspace name cleared');
    await dispatched(store, saveSettings({ workspaceName: '   ' }));
    assert.equal(store.getState().ui.toasts.at(-1)?.desc, 'Workspace name cleared');
    await dispatched(store, saveSettings({ operatorName: ' ' }));
    assert.equal(store.getState().ui.toasts.at(-1)?.desc, 'Your name cleared');
    await dispatched(store, saveSettings({ workspaceName: ' Personal ' }));
    assert.equal(store.getState().ui.toasts.at(-1)?.desc, 'Workspace name: “Personal”');
    assert.deepEqual(store.getState().session.settingsSaved, { workspaceName: 3, operatorName: 1 });
  });

  it('reports a failed save and frees the card', async () => {
    const api = fakeApi({
      settings: {
        update: async () => {
          throw new ApiError(400, 'bad_request', 'operatorName must be at most 100 chars');
        },
      },
    });
    const store = createStore({ api, initialRoute: { key: 'settings' } });

    await dispatched(store, sessionCheck());
    await settle();
    await dispatched(store, saveSettings({ operatorName: 'x' }));

    assert.deepEqual(store.getState().session.settingsSaving, { workspaceName: false, operatorName: false });
    assert.deepEqual(store.getState().session.settingsSaved, { workspaceName: 0, operatorName: 0 });
    assert.equal(selectOperatorName(store.getState()), null);
    assert.deepEqual(
      store.getState().ui.toasts.map(toast => [toast.title, toast.desc, toast.state]),
      [['Couldn’t save', 'operatorName must be at most 100 chars', 'err']],
    );
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

  it('reads the headless policy of a started thread from its thread.started', () => {
    resetSeq(220n);

    const store = createStore({ api: fakeApi(), initialRoute: { key: 'home' } });

    store.dispatch(eventAction(event({ type: 'thread.started', threadId: 'h1', targetThreadId: 'main', payload: { agent: 'gardener', headless: true } })));
    store.dispatch(eventAction(event({ type: 'thread.started', threadId: 'h2', targetThreadId: 'main', payload: { agent: 'engineer' } })));
    assert.equal(created(store, 'h1').headless, true);
    assert.equal(created(store, 'h2').headless, false);
  });

  it('keeps the last message of the main thread the snapshot carried, and the pinned row takes the later of it and the loaded events', async () => {
    resetSeq(230n);

    const kept = event({ type: 'user.message', actor: 'user', threadId: 'main', payload: { text: 'Start the designer' } });
    let carried = kept;
    const store = createStore({
      api: fakeApi({ snapshot: async () => snapshot({ threads: [thread({ id: 'main', parentId: null, agent: 'coordinator' })], mainLastMessage: carried }) }),
      initialRoute: { key: 'home' },
    });
    const selectLastMessage = makeSelectLastMessage();
    const last = () => selectLastMessage(store.getState(), 'main');
    const keptMessage = { text: 'Start the designer', at: kept.createdAt, seq: kept.seq };

    assert.equal(store.getState().threads.mainLastMessage, null);
    assert.equal(last(), null);
    await dispatched(store, sessionCheck());
    await settle();
    assert.deepEqual(store.getState().threads.mainLastMessage, kept);
    // The snapshot's message is not a loaded event of the feed: the feed
    // still starts where the tail or the thread's chunk puts it — and the
    // row has its words before any event of the thread is loaded.
    assert.equal(store.getState().feed.byThread.main, undefined);
    assert.deepEqual(last(), keptMessage);

    // The tail: a child starts and reports to the main thread — events of
    // its feed, but not messages.
    store.dispatch(eventAction(event({ type: 'thread.started', threadId: 'c1', targetThreadId: 'main', agentName: 'designer', payload: { agent: 'designer' } })));
    store.dispatch(eventAction(event({ type: 'thread.progress', threadId: 'c1', targetThreadId: 'main', agentName: 'designer', payload: { text: 'Drawing the chart' } })));
    assert.deepEqual(store.getState().feed.byThread.main?.seqs, ['231', '232']);
    assert.deepEqual(last(), keptMessage);

    // The child's message addressed to the main thread is later by seq: the row's.
    const reply = event({ type: 'agent.message', threadId: 'c1', targetThreadId: 'main', agentName: 'designer', payload: { content: [{ type: 'text', text: 'The chart is ready.' }] } });
    const replyMessage = { text: 'The chart is ready.', at: reply.createdAt, seq: reply.seq };

    store.dispatch(eventAction(reply));
    assert.deepEqual(last(), replyMessage);

    // A message inside the child only and a later non-message of the main thread change nothing.
    store.dispatch(eventAction(event({ type: 'agent.message', threadId: 'c1', agentName: 'designer', payload: { content: [{ type: 'text', text: 'Inside the child' }] } })));
    store.dispatch(eventAction(event({ type: 'tool.call.started', threadId: 'main', agentName: 'coordinator', payload: { callId: 'c', functionName: 'spawn_agent', input: {} } })));
    assert.deepEqual(last(), replyMessage);
    assert.equal(last(), last());

    // A snapshot taken again (a reconnect) still carrying the older message:
    // the loaded events keep the later one.
    await dispatched(store, snapshotLoad());
    await settle();
    assert.deepEqual(store.getState().threads.mainLastMessage, kept);
    assert.deepEqual(last(), replyMessage);

    // A snapshot ahead of the loaded events (the tab was away): its message is the row's.
    const ahead = event({ type: 'user.message', actor: 'user', threadId: 'main', payload: { text: 'Now deploy it' } });

    carried = ahead;
    await dispatched(store, snapshotLoad());
    await settle();
    assert.deepEqual(last(), { text: 'Now deploy it', at: ahead.createdAt, seq: ahead.seq });
  });
});

function created(store: AppStore, id: string): Thread {
  return store.getState().threads.byId[id]!;
}

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

  it('asks a chunk from the head after the seq the tail last delivered, and after the snapshot before the tail flows', async () => {
    const calls: Calls = [];
    const api = fakeApi({ threads: { events: async () => ({ events: [], nextCursor: null }) } }, calls);
    const store = createStore({ api, initialRoute: { key: 'home' } });
    const eventsCalls = () => calls.filter(call => call.name === 'threads.events').map(call => call.args[1]);

    await dispatched(store, sessionCheck());
    await settle();
    await dispatched(store, loadThreadEvents('t1', null));
    assert.deepEqual(eventsCalls(), [{ before: 101n, limit: 500 }]);

    // The tail has moved: the store holds everything after its last frame
    // (what an eviction took before it is the chunk's to bring back).
    store.dispatch(eventAction(event({ type: 'thread.progress', seq: 180n, threadId: 't2', payload: { text: 'x' } })));
    await dispatched(store, loadThreadEvents('t1', null));
    assert.deepEqual(eventsCalls().at(-1), { before: 181n, limit: 500 });

    // A frame below the snapshot's stamp does not move the head below it.
    const other = createStore({ api: fakeApi({ threads: { events: async () => ({ events: [], nextCursor: null }) } }, calls), initialRoute: { key: 'home' } });

    await dispatched(other, sessionCheck());
    await settle();
    other.dispatch(eventAction(event({ type: 'thread.progress', seq: 25n, threadId: 't2', payload: { text: 'x' } })));
    await dispatched(other, loadThreadEvents('t1', null));
    assert.deepEqual(eventsCalls().at(-1), { before: 101n, limit: 500 });
  });
});

describe('route data', () => {
  it('loads the threads page for the list route once per filter set', async () => {
    const calls: Calls = [];
    const api = fakeApi(
      {
        snapshot: async () =>
          snapshot({
            projects: [{ id: 'p1', slug: 'balabash', title: 'Balabash', description: '', archived: false, archivedAt: null, createdAt: new Date(), updatedAt: new Date() }],
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
    assert.deepEqual(store.getState().router, { route: { key: 'apps' }, source: 'app', replace: false, hash: '', scroll: null });
  });

  it('keeps the router state as is on ROUTE_TO from the app to the current route', () => {
    const store = createStore({ api: fakeApi(), initialRoute: { key: 'thread', id: 'main' } });
    const before = store.getState().router;

    store.dispatch({ type: 'MORE_SHEET_OPEN' });
    store.dispatch(routeTo({ key: 'thread', id: 'main' }));
    assert.equal(store.getState().router, before);
    assert.equal(store.getState().ui.moreSheet, false);
    store.dispatch(routeTo({ key: 'thread', id: 'main' }, { replace: true }));
    assert.equal(store.getState().router, before);
    store.dispatch(routeTo({ key: 'thread', id: 'other' }));
    assert.notEqual(store.getState().router, before);
    assert.deepEqual(store.getState().router.route, { key: 'thread', id: 'other' });
  });

  it('takes a ROUTE_TO from history as a new state even at the current URL: a popstate is a move between two entries', () => {
    const store = createStore({ api: fakeApi(), initialRoute: { key: 'threads', agent: 'engineer' } });
    const before = store.getState().router;

    // Back from a neighbour that a replace gave the same URL: the entry's own place comes with it.
    store.dispatch(routeTo({ key: 'threads', agent: 'engineer' }, { source: 'history', scroll: 600 }));

    const back = store.getState().router;

    assert.notEqual(back, before);
    assert.equal(back.route, before.route);
    assert.deepEqual(back, { route: { key: 'threads', agent: 'engineer' }, source: 'history', replace: false, hash: '', scroll: 600 });

    // Forward to the neighbour, left at the same place: equal fields, another state.
    store.dispatch(routeTo({ key: 'threads', agent: 'engineer' }, { source: 'history', scroll: 600 }));

    const forward = store.getState().router;

    assert.notEqual(forward, back);
    assert.equal(forward.route, before.route);
    assert.deepEqual(forward, back);

    // An entry without a place is a move too (the screen starts at the top).
    store.dispatch(routeTo({ key: 'threads', agent: 'engineer' }, { source: 'history' }));
    assert.notEqual(store.getState().router, forward);
    assert.equal(store.getState().router.scroll, null);

    // The app's own link to the current route still changes nothing.
    const kept = store.getState().router;

    store.dispatch(routeTo({ key: 'threads', agent: 'engineer' }));
    assert.equal(store.getState().router, kept);
  });

  it('carries the fragment of the URL beside the route: a new fragment of the same route is a new state with the same route object', () => {
    const store = createStore({ api: fakeApi(), initialRoute: { key: 'files', path: 'a.md' }, initialHash: '#top' });

    assert.equal(store.getState().router.hash, '#top');

    store.dispatch(routeTo({ key: 'files', path: 'a.md' }, { hash: '#top' }));
    const before = store.getState().router;

    assert.equal(before.hash, '#top');
    store.dispatch(routeTo({ key: 'files', path: 'a.md' }, { hash: '#part' }));

    const next = store.getState().router;

    assert.notEqual(next, before);
    assert.equal(next.route, before.route);
    assert.equal(next.hash, '#part');
    assert.equal(next.replace, false);

    store.dispatch(routeTo({ key: 'files', path: 'a.md' }, { hash: '#part' }));
    assert.equal(store.getState().router, next);

    // A route without a fragment drops the one before.
    store.dispatch(routeTo({ key: 'files', path: 'b.md' }));
    assert.deepEqual(store.getState().router, { route: { key: 'files', path: 'b.md' }, source: 'app', replace: false, hash: '', scroll: null });

    // history brings the location's fragment back, and the place the entry was left at.
    store.dispatch(routeTo({ key: 'files', path: 'a.md' }, { source: 'history', hash: '#part', scroll: 120 }));
    assert.deepEqual(store.getState().router, { route: { key: 'files', path: 'a.md' }, source: 'history', replace: false, hash: '#part', scroll: 120 });

    // An app navigation has no place to bring back: its screen starts at the top.
    store.dispatch(routeTo({ key: 'files', path: 'b.md' }));
    assert.equal(store.getState().router.scroll, null);
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

            return { thread: thread({ id, agent: 'browser', createdSeq: 3n }) };
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
  const project = (id: string, updatedAt: Date, archived = false) => ({ id, title: id, slug: id, description: '', archived, archivedAt: archived ? updatedAt : null, createdAt: updatedAt, updatedAt });

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
            { name: 'engineer', description: 'code', icon: null, sdk: 'claude', tools: ['events'], agents: ['browser'], headless: false, notification: null, model: 'm', effort: 'high', defaultEffort: 'high', lastModel: null },
            { name: 'browser', description: 'web', icon: null, sdk: 'claude', tools: [], agents: [], headless: true, notification: null, model: null, effort: null, defaultEffort: 'high', lastModel: null },
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

  it('follows the model an agent’s newest session started with', async () => {
    const store = await agentsStore();
    const started = (seq: bigint, agentName: string, model: string) =>
      eventAction(event({ seq, type: 'session.started', threadId: 'e1', agentName, payload: { model, tools: [], mcpServers: [] } }));

    assert.equal(store.getState().agents.byName.engineer.lastModel, null);

    store.dispatch(started(53n, 'engineer', 'claude-opus-5-5'));
    assert.equal(store.getState().agents.byName.engineer.lastModel, 'claude-opus-5-5');
    assert.equal(store.getState().agents.byName.engineer.model, 'm');
    assert.equal(store.getState().agents.byName.browser.lastModel, null);

    // The same model again, an agent outside the catalog — nothing changes.
    const before = store.getState().agents;

    store.dispatch(started(54n, 'engineer', 'claude-opus-5-5'));
    store.dispatch(started(55n, 'gardener', 'claude-opus-5-5'));
    store.dispatch(started(56n, 'constructor', 'claude-opus-5-5'));
    assert.equal(store.getState().agents, before);

    // A newer start naming no model leaves the agent without one — the
    // snapshot's rule (readLastModels reads the newest start, whatever it
    // names), so a reload shows the same catalog; again, nothing changes.
    const unnamed = (seq: bigint, payload: Record<string, unknown>) =>
      eventAction(event({ seq, type: 'session.started', threadId: 'e1', agentName: 'engineer', payload: { tools: [], mcpServers: [], ...payload } as never }));

    store.dispatch(unnamed(57n, {}));
    assert.equal(store.getState().agents.byName.engineer.lastModel, null);
    assert.equal(store.getState().agents.byName.engineer.model, 'm');

    const cleared = store.getState().agents;

    store.dispatch(unnamed(58n, { model: '' }));
    assert.equal(store.getState().agents, cleared);

    // A newer start on another model replaces it.
    store.dispatch(started(59n, 'engineer', 'claude-opus-5-5-20260301'));
    assert.equal(store.getState().agents.byName.engineer.lastModel, 'claude-opus-5-5-20260301');
    assert.deepEqual(store.getState().agents.names, ['engineer', 'browser']);
  });
});

describe('registry events', () => {
  const ISO = '2026-10-09T10:00:00.000Z';
  const LATER = '2026-10-09T12:00:00.000Z';

  it('keeps the projects of the snapshot up to date from project.* events', async () => {
    resetSeq(300n);

    const store = createStore({ api: fakeApi({ snapshot: async () => snapshot({ projects: [{ id: 'p1', title: 'One', slug: 'one', description: 'd', archived: false, archivedAt: null, createdAt: new Date(ISO), updatedAt: new Date(ISO) }] }) }), initialRoute: { key: 'home' } });

    await dispatched(store, sessionCheck());
    await settle();

    store.dispatch(eventAction(event({ type: 'project.created', actor: 'user', payload: { id: 'p2', title: 'Two', slug: 'two', description: 'd2', archived: false, createdAt: LATER, updatedAt: LATER } })));
    assert.deepEqual(selectActiveProjects(store.getState()).map(project => project.id), ['p2', 'p1']);

    store.dispatch(eventAction(event({ type: 'project.updated', threadId: 'main', payload: { id: 'p1', title: 'One renamed', slug: 'one', description: 'd', archived: false, createdAt: ISO, updatedAt: '2026-10-09T13:00:00.000Z' } })));
    assert.equal(store.getState().projects.byId.p1.title, 'One renamed');
    assert.deepEqual(selectActiveProjects(store.getState()).map(project => project.id), ['p1', 'p2']);

    store.dispatch(eventAction(event({ type: 'project.archived', threadId: 'main', payload: { id: 'p2', title: 'Two', slug: 'two', description: 'd2', archived: true, archivedAt: LATER, createdAt: LATER, updatedAt: LATER } })));
    assert.equal(selectArchivedProjectCount(store.getState()), 1);
    assert.deepEqual(store.getState().projects.ids, ['p1', 'p2']);
    assert.equal(store.getState().projects.byId.p2.archivedAt?.toISOString(), LATER);
    // A record written before the date was kept folds in without one.
    store.dispatch(eventAction(event({ type: 'project.archived', threadId: 'main', payload: { id: 'p1', title: 'One renamed', slug: 'one', description: 'd', archived: true, createdAt: ISO, updatedAt: '2026-10-09T14:00:00.000Z' } })));
    assert.equal(store.getState().projects.byId.p1.archived, true);
    assert.equal(store.getState().projects.byId.p1.archivedAt, null);

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

    // The same publication again keeps the rows (the screen's elements) and dates them.
    const published = store.getState().apps;

    store.dispatch(eventAction(event({ type: 'app.published', actor: 'user', payload: { path: 'b/tracker', slug: 'tracker', name: 'Tracker', description: null } })));
    assert.equal(store.getState().apps.items, published.items);
    assert.equal(store.getState().apps.eventSeq, 341n);

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

describe('project registry changes', () => {
  const ISO = '2026-10-09T10:00:00.000Z';
  const row = (id: string, patch: Partial<ProjectView> = {}): ProjectView => ({ id, title: 'One', slug: 'one', description: 'd', archived: false, archivedAt: null, createdAt: new Date(ISO), updatedAt: new Date(ISO), ...patch });

  it('creates a project: one call at a time, the row folded, a toast, the page opened', async () => {
    const calls: Calls = [];
    const api = fakeApi({ projects: { create: async input => ({ project: row('p9', { title: input.title, slug: input.slug, description: input.description }), adopted: true }) } }, calls);
    const store = createStore({ api, initialRoute: { key: 'projects' } });

    await dispatched(store, sessionCheck());
    await settle();

    const creating = store.dispatch(createProject({ title: 'Nine', slug: 'nine', description: 'ninth' }));

    assert.equal(selectProjectCreate(store.getState()).pending, true);
    // A second submit while the first is in flight is not a call.
    await dispatched(store, createProject({ title: 'Ten', slug: 'ten', description: 'tenth' }));
    assert.equal(calls.filter(call => call.name === 'projects.create').length, 1);
    await creating;

    const state = store.getState();

    assert.deepEqual(selectProjectCreate(state), { pending: false, error: null, done: 1 });
    assert.equal(state.projects.byId.p9?.slug, 'nine');
    assert.deepEqual(selectActiveProjects(state).map(project => project.id), ['p9']);
    assert.deepEqual(
      state.ui.toasts.map(toast => [toast.title, toast.desc, toast.state]),
      [['Project created', '“Nine” — the existing folder nine/ is its library; its files are kept.', 'done']],
    );
    assert.deepEqual(state.router.route, { key: 'project', slug: 'nine' });

    // The tail's own event of the same row is idempotent.
    store.dispatch(eventAction(event({ type: 'project.created', actor: 'user', payload: { id: 'p9', title: 'Nine', slug: 'nine', description: 'ninth', archived: false, createdAt: ISO, updatedAt: ISO } })));
    assert.deepEqual(store.getState().projects.ids, ['p9']);
  });

  it('does not pull the operator back to a project created after they left the Projects screen', async () => {
    let answer: (value: Awaited<ReturnType<Api['projects']['create']>>) => void = () => undefined;
    const api = fakeApi({ projects: { create: () => new Promise(resolve => (answer = resolve)) } });
    const store = createStore({ api, initialRoute: { key: 'projects' } });

    await dispatched(store, sessionCheck());
    await settle();

    const creating = store.dispatch(createProject({ title: 'Nine', slug: 'nine', description: 'ninth' }));

    // The form was closed and Settings opened while the call ran.
    store.dispatch(routeTo({ key: 'settings' }));
    answer({ project: row('p9', { title: 'Nine', slug: 'nine', description: 'ninth' }), adopted: false });
    await creating;

    const state = store.getState();

    assert.deepEqual(state.router.route, { key: 'settings' });
    assert.equal(state.projects.byId.p9?.slug, 'nine');
    assert.deepEqual(selectProjectCreate(state), { pending: false, error: null, done: 1 });
    // The toast offers the page instead.
    assert.deepEqual(state.ui.toasts.map(toast => [toast.title, toast.action]), [['Project created', { label: 'Open', route: { key: 'project', slug: 'nine' } }]]);
  });

  it('folds a row only when it is at least as new as the one held — the answer and the tail may cross', async () => {
    const T1 = new Date('2026-10-09T10:01:00.000Z');
    const T2 = new Date('2026-10-09T10:02:00.000Z');
    let answer: (value: Awaited<ReturnType<Api['projects']['update']>>) => void = () => undefined;
    const api = fakeApi({
      snapshot: async () => snapshot({ projects: [row('p1')] }),
      projects: { update: () => new Promise(resolve => (answer = resolve)), archive: async id => ({ project: row(id, { archived: true, updatedAt: T2 }) }) },
    });
    const store = createStore({ api, initialRoute: { key: 'project', slug: 'one' } });

    await dispatched(store, sessionCheck());
    await settle();

    // The edit's answer (version T1) is delayed; the tail brings the archiving (T2) first.
    const saving = store.dispatch(updateProject('p1', { title: 'Renamed' }));

    store.dispatch(eventAction(event({ type: 'project.archived', threadId: 'main', payload: { id: 'p1', title: 'Renamed', slug: 'one', description: 'd', archived: true, createdAt: ISO, updatedAt: T2.toISOString() } })));
    answer({ project: row('p1', { title: 'Renamed', archived: false, updatedAt: T1 }) });
    await saving;

    assert.equal(store.getState().projects.byId.p1?.archived, true, 'the late answer does not put the project back among the active ones');
    assert.equal(store.getState().projects.byId.p1?.updatedAt.getTime(), T2.getTime());
    assert.deepEqual(selectProjectEdit(store.getState(), 'p1'), { pending: false, error: null, done: 1 }, 'the form still counts its accepted call');

    // The other way round: the answer of the archiving (T2) landed, the tail's older event (T1) trails.
    await dispatched(store, setProjectArchived('p1', true));
    store.dispatch(eventAction(event({ type: 'project.updated', threadId: 'main', payload: { id: 'p1', title: 'Renamed', slug: 'one', description: 'd', archived: false, createdAt: ISO, updatedAt: T1.toISOString() } })));
    assert.equal(store.getState().projects.byId.p1?.archived, true);

    // The same version again (the tail's event of the answer's own row) is folded as before: idempotent.
    store.dispatch(eventAction(event({ type: 'project.archived', threadId: 'main', payload: { id: 'p1', title: 'Renamed', slug: 'one', description: 'd', archived: true, createdAt: ISO, updatedAt: T2.toISOString() } })));
    assert.equal(store.getState().projects.byId.p1?.title, 'Renamed');
    // A newer version is taken.
    const T3 = '2026-10-09T10:03:00.000Z';

    store.dispatch(eventAction(event({ type: 'project.unarchived', threadId: 'main', payload: { id: 'p1', title: 'Renamed', slug: 'one', description: 'd', archived: false, createdAt: ISO, updatedAt: T3 } })));
    assert.equal(store.getState().projects.byId.p1?.archived, false);
  });

  it('keeps a refused creation in the form, without a toast or a route change', async () => {
    const api = fakeApi({
      projects: {
        create: async () => {
          throw new ApiError(409, 'conflict', 'title "Nine" or slug "nine" is already taken — check the projects list');
        },
      },
    });
    const store = createStore({ api, initialRoute: { key: 'projects' } });

    await dispatched(store, sessionCheck());
    await settle();
    await dispatched(store, createProject({ title: 'Nine', slug: 'nine', description: 'ninth' }));

    const state = store.getState();

    assert.deepEqual(selectProjectCreate(state), { pending: false, error: { status: 409, code: 'conflict', message: 'title "Nine" or slug "nine" is already taken — check the projects list' }, done: 0 });
    assert.deepEqual(state.ui.toasts, []);
    assert.deepEqual(state.router.route, { key: 'projects' });
    assert.deepEqual(state.projects.ids, []);

    // The next attempt starts clean.
    const retry = store.dispatch(createProject({ title: 'Nine', slug: 'nine-2', description: 'ninth' }));

    assert.deepEqual(selectProjectCreate(store.getState()), { pending: true, error: null, done: 0 });
    await retry;
  });

  it('edits a project by id: the answer updates the row, the form counts the save', async () => {
    const calls: Calls = [];
    const api = fakeApi(
      {
        snapshot: async () => snapshot({ projects: [row('p1'), row('p2', { slug: 'two', title: 'Two' })] }),
        projects: { update: async (id, patch) => ({ project: row(id, { title: patch.title ?? 'One', updatedAt: new Date('2026-10-09T11:00:00.000Z') }) }) },
      },
      calls,
    );
    const store = createStore({ api, initialRoute: { key: 'project', slug: 'one' } });

    await dispatched(store, sessionCheck());
    await settle();

    const saving = store.dispatch(updateProject('p1', { title: 'One renamed' }));

    assert.equal(selectProjectEdit(store.getState(), 'p1').pending, true);
    assert.equal(selectProjectEdit(store.getState(), 'p2').pending, false);
    await dispatched(store, updateProject('p1', { title: 'Again' }));
    assert.equal(calls.filter(call => call.name === 'projects.update').length, 1);
    await saving;

    const state = store.getState();

    assert.deepEqual(selectProjectEdit(state, 'p1'), { pending: false, error: null, done: 1 });
    assert.equal(state.projects.byId.p1?.title, 'One renamed');
    assert.deepEqual(selectActiveProjects(state).map(project => project.id), ['p1', 'p2']);
    assert.deepEqual(state.ui.toasts.map(toast => [toast.title, toast.desc]), [['Saved', '“One renamed”']]);
    assert.deepEqual(calls.find(call => call.name === 'projects.update')?.args, ['p1', { title: 'One renamed' }]);
  });

  it('flips the archive flag, and says so when it cannot', async () => {
    const api = fakeApi({
      snapshot: async () => snapshot({ projects: [row('p1'), row('p2', { slug: 'two', title: 'Two' })] }),
      projects: {
        archive: async id => ({ project: row(id, { archived: true }) }),
        unarchive: async () => {
          throw new ApiError(404, 'not_found', 'no such project');
        },
      },
    });
    const store = createStore({ api, initialRoute: { key: 'project', slug: 'one' } });

    await dispatched(store, sessionCheck());
    await settle();

    const archiving = store.dispatch(setProjectArchived('p1', true));

    assert.equal(selectProjectFlagging(store.getState(), 'p1'), true);
    assert.equal(selectProjectFlagging(store.getState(), 'p2'), false);
    await archiving;

    assert.equal(selectProjectFlagging(store.getState(), 'p1'), false);
    assert.deepEqual(selectArchivedProjects(store.getState()).map(project => project.id), ['p1']);
    assert.deepEqual(selectActiveProjects(store.getState()).map(project => project.id), ['p2']);
    assert.deepEqual(store.getState().ui.toasts.map(toast => [toast.title, toast.state]), [['Archived', 'off']]);

    await dispatched(store, setProjectArchived('p1', false));
    assert.equal(selectProjectFlagging(store.getState(), 'p1'), false);
    assert.equal(store.getState().projects.byId.p1?.archived, true);
    assert.deepEqual(store.getState().ui.toasts.at(-1), { id: 2, title: 'Couldn’t unarchive', desc: 'no such project', state: 'err' });
  });

  it('lists the threads of a project: active first, then newest', async () => {
    const api = fakeApi({
      snapshot: async () =>
        snapshot({
          projects: [row('p1')],
          threads: [
            thread({ id: 'main', parentId: null, agent: 'coordinator', projectId: 'p1' }),
            thread({ id: 'a', projectId: 'p1', createdSeq: 10n, status: 'completed', terminalSeq: 12n }),
            thread({ id: 'b', projectId: 'p1', createdSeq: 5n }),
            thread({ id: 'c', projectId: 'p2', createdSeq: 20n }),
            thread({ id: 'd', projectId: 'p1', createdSeq: 30n, status: 'failed', terminalSeq: 31n }),
          ],
        }),
    });
    const store = createStore({ api, initialRoute: { key: 'project', slug: 'one' } });

    await dispatched(store, sessionCheck());
    await settle();

    const select = makeSelectProjectThreads();

    assert.deepEqual(select(store.getState(), 'p1').map(t => t.id), ['b', 'd', 'a']);
    assert.deepEqual(select(store.getState(), 'p3'), []);
  });
});

describe('apps publication', () => {
  const TRACKER = { path: 'b/tracker', name: 'Tracker', description: null, manifestError: null, slug: null };
  const KCAL = { path: 'apps/kcal', name: 'Calorie tracker', description: null, manifestError: null, slug: 'kcal' };
  const listing = (apps: AppsResponse['apps']): AppsResponse => ({ apps, publicAppsBase: 'https://apps.example' });
  const toasts = (store: AppStore) => store.getState().ui.toasts.map(toast => ({ title: toast.title, desc: toast.desc, state: toast.state }));
  const row = (store: AppStore, path: string) => store.getState().apps.items.find(item => item.path === path);

  type Answer = { resolve: (publication: { path: string; slug: string }) => void; reject: (error: unknown) => void };

  const held = (answers: Answer[]) => () =>
    new Promise<{ path: string; slug: string }>((resolve, reject) => {
      answers.push({ resolve, reject });
    });

  async function onApps(overrides: ApiOverrides = {}, calls: Calls = []): Promise<AppStore> {
    const store = createStore({ api: fakeApi({ snapshot: async () => snapshot({ apps: listing([KCAL, TRACKER]) }), ...overrides }, calls), initialRoute: { key: 'apps' } });

    await dispatched(store, sessionCheck());
    await settle();

    return store;
  }

  it('publishes: one call per app, the slug folded from the answer, the form counted accepted, a toast with the address', async () => {
    const calls: Calls = [];
    const answers: Answer[] = [];
    const store = await onApps({ apps: { publish: held(answers) } }, calls);

    store.dispatch(publishApp('b/tracker', 'tracker'));
    store.dispatch(publishApp('b/tracker', 'other'));
    assert.equal(answers.length, 1);
    assert.deepEqual(calls.filter(call => call.name === 'apps.publish').map(call => call.args), [[{ path: 'b/tracker', slug: 'tracker' }]]);
    assert.deepEqual(selectAppCall(store.getState(), 'b/tracker'), { kind: 'publish', slug: 'tracker', since: null });
    assert.deepEqual(selectAppPublish(store.getState(), 'b/tracker'), { pending: true, error: null, done: 0 });
    // Another app is free to be called meanwhile.
    assert.equal(selectAppCall(store.getState(), 'apps/kcal'), null);

    answers[0].resolve({ path: 'b/tracker', slug: 'tracker' });
    await settle();
    assert.equal(row(store, 'b/tracker')?.slug, 'tracker');
    assert.equal(selectAppCall(store.getState(), 'b/tracker'), null);
    assert.deepEqual(selectAppPublish(store.getState(), 'b/tracker'), { pending: false, error: null, done: 1 });
    assert.deepEqual(toasts(store), [{ title: 'Published', desc: '“Tracker” — apps.example/tracker', state: 'done' }]);

    // The tail's event of the same change is idempotent on the row.
    const rows = store.getState().apps.items;

    store.dispatch(eventAction(event({ type: 'app.published', actor: 'user', payload: { path: 'b/tracker', slug: 'tracker', name: 'Tracker', description: null } })));
    assert.equal(store.getState().apps.items, rows);
  });

  it('keeps a refusal of a publish in the form, without a toast; the next call clears it', async () => {
    let fail = true;
    const store = await onApps({
      apps: {
        publish: async input => {
          if (fail) {
            throw new ApiError(400, 'bad_request', 'The slug "kcal" is taken — pick another one');
          }

          return { path: input.path, slug: input.slug };
        },
      },
    });

    await dispatched(store, publishApp('b/tracker', 'kcal'));
    await settle();
    assert.equal(row(store, 'b/tracker')?.slug, null);
    assert.deepEqual(selectAppPublish(store.getState(), 'b/tracker'), { pending: false, error: { status: 400, code: 'bad_request', message: 'The slug "kcal" is taken — pick another one' }, done: 0 });
    assert.deepEqual(toasts(store), []);

    fail = false;
    store.dispatch(publishApp('b/tracker', 'tracker'));
    assert.equal(selectAppPublish(store.getState(), 'b/tracker').error, null);
    await settle();
    assert.equal(row(store, 'b/tracker')?.slug, 'tracker');
    assert.deepEqual(selectAppPublish(store.getState(), 'b/tracker'), { pending: false, error: null, done: 1 });
  });

  it('unpublishes: the slug dropped from the answer, a toast; a refusal is a toast', async () => {
    const calls: Calls = [];
    let fail = false;
    const store = await onApps(
      {
        apps: {
          unpublish: async input => {
            if (fail) {
              throw new ApiError(400, 'bad_request', 'apps/kcal is not published');
            }

            return { path: input.path ?? '', slug: 'kcal' };
          },
        },
      },
      calls,
    );

    store.dispatch(unpublishApp('apps/kcal'));
    assert.deepEqual(selectAppCall(store.getState(), 'apps/kcal'), { kind: 'unpublish', since: null });
    // A publish of the same app waits for the call in flight.
    store.dispatch(publishApp('apps/kcal', 'other'));
    assert.deepEqual(selectAppCall(store.getState(), 'apps/kcal'), { kind: 'unpublish', since: null });
    await settle();
    assert.deepEqual(calls.filter(call => call.name === 'apps.unpublish').map(call => call.args), [[{ path: 'apps/kcal' }]]);
    assert.equal(calls.filter(call => call.name === 'apps.publish').length, 0);
    assert.equal(row(store, 'apps/kcal')?.slug, null);
    assert.equal(selectAppCall(store.getState(), 'apps/kcal'), null);
    assert.deepEqual(toasts(store), [{ title: 'Unpublished', desc: '“Calorie tracker” — the link apps.example/kcal stopped working.', state: 'off' }]);

    fail = true;
    await dispatched(store, unpublishApp('apps/kcal'));
    await settle();
    assert.equal(selectAppCall(store.getState(), 'apps/kcal'), null);
    assert.deepEqual(toasts(store).at(-1), { title: 'Couldn’t unpublish', desc: 'apps/kcal is not published', state: 'err' });
  });

  it('drops an answer that outlived its session', async () => {
    const answers: Answer[] = [];
    const store = await onApps({ apps: { publish: held(answers) } });

    store.dispatch(publishApp('b/tracker', 'tracker'));
    store.dispatch(sessionLost());
    await dispatched(store, sessionCheck());
    await settle();
    assert.equal(selectAppCall(store.getState(), 'b/tracker'), null);

    // The new session's own call on the same app.
    store.dispatch(publishApp('b/tracker', 'fresh'));
    assert.equal(answers.length, 2);
    answers[0].resolve({ path: 'b/tracker', slug: 'tracker' });
    await settle();
    assert.deepEqual(selectAppCall(store.getState(), 'b/tracker'), { kind: 'publish', slug: 'fresh', since: null });
    assert.equal(row(store, 'b/tracker')?.slug, null);
    assert.deepEqual(toasts(store), []);

    answers[1].resolve({ path: 'b/tracker', slug: 'fresh' });
    await settle();
    assert.equal(row(store, 'b/tracker')?.slug, 'fresh');
    assert.deepEqual(selectAppPublish(store.getState(), 'b/tracker'), { pending: false, error: null, done: 1 });
  });

  it('keeps the folded answer against a listing read before the call: the stale listing is not applied, the listing is read again', async () => {
    const calls: Calls = [];
    const lists: { resolve: (apps: AppsResponse) => void }[] = [];
    const store = await onApps({ apps: { list: () => new Promise<AppsResponse>(resolve => lists.push({ resolve })) } }, calls);
    const listCalls = () => calls.filter(call => call.name === 'apps.list').length;

    // The Apps screen entered (or the tab back): a listing leaves, reading slug null.
    store.dispatch(loadApps());
    assert.equal(lists.length, 1);

    // The publish answers first — before the tail's app.published.
    await dispatched(store, publishApp('b/tracker', 'tracker'));
    await settle();
    assert.equal(row(store, 'b/tracker')?.slug, 'tracker');
    assert.equal(store.getState().apps.eventSeq, null);

    // The old listing lands: it predates the publish and is not applied; the listing is asked for again.
    lists[0].resolve(listing([KCAL, TRACKER]));
    await settle();
    assert.equal(row(store, 'b/tracker')?.slug, 'tracker');
    assert.equal(listCalls(), 2);
    assert.equal(lists.length, 2);

    lists[1].resolve(listing([KCAL, { ...TRACKER, slug: 'tracker' }]));
    await settle();
    assert.equal(row(store, 'b/tracker')?.slug, 'tracker');
    assert.equal(store.getState().apps.refresh.request, null);
    assert.equal(listCalls(), 2);

    // The mirror: a listing in flight across an unpublish does not bring the slug back.
    store.dispatch(loadApps());
    await dispatched(store, unpublishApp('apps/kcal'));
    await settle();
    assert.equal(row(store, 'apps/kcal')?.slug, null);
    lists[2].resolve(listing([KCAL, { ...TRACKER, slug: 'tracker' }]));
    await settle();
    assert.equal(row(store, 'apps/kcal')?.slug, null);
    assert.equal(lists.length, 4);
    lists[3].resolve(listing([{ ...KCAL, slug: null }, { ...TRACKER, slug: 'tracker' }]));
    await settle();
    assert.equal(row(store, 'apps/kcal')?.slug, null);
    assert.equal(store.getState().apps.refresh.request, null);

    // A refusal changed nothing on the server: a listing across it stands.
    const refused = await onApps({ apps: { list: () => new Promise<AppsResponse>(resolve => lists.push({ resolve })), publish: async () => Promise.reject(new ApiError(400, 'bad_request', 'The slug "x" is taken — pick another one')) } });

    refused.dispatch(loadApps());
    await dispatched(refused, publishApp('b/tracker', 'x'));
    await settle();
    lists[4].resolve(listing([KCAL, TRACKER, { ...TRACKER, path: 'c/late' }]));
    await settle();
    assert.equal(refused.getState().apps.items.length, 3);
    assert.equal(lists.length, 5);
  });

  it('does not fold an answer the tail has outrun: the newer app.* events keep the row', async () => {
    resetSeq(500n);

    const answers: Answer[] = [];
    const store = await onApps({ apps: { publish: held(answers), unpublish: held(answers) } });

    // This tab publishes; its answer is late. The tail brings its own
    // app.published, then an unpublish from elsewhere (another tab, an agent).
    store.dispatch(publishApp('b/tracker', 'tracker'));
    assert.deepEqual(selectAppCall(store.getState(), 'b/tracker'), { kind: 'publish', slug: 'tracker', since: null });
    store.dispatch(eventAction(event({ type: 'app.published', actor: 'user', payload: { path: 'b/tracker', slug: 'tracker', name: 'Tracker', description: null } })));
    assert.equal(row(store, 'b/tracker')?.slug, 'tracker');
    store.dispatch(eventAction(event({ type: 'app.unpublished', actor: 'user', payload: { path: 'b/tracker', slug: 'tracker' } })));
    assert.equal(row(store, 'b/tracker')?.slug, null);

    // The late 200: the call ends, the form counts it accepted, the toast tells it — the row keeps the tail's word.
    answers[0].resolve({ path: 'b/tracker', slug: 'tracker' });
    await settle();
    assert.equal(row(store, 'b/tracker')?.slug, null);
    assert.equal(selectAppCall(store.getState(), 'b/tracker'), null);
    assert.deepEqual(selectAppPublish(store.getState(), 'b/tracker'), { pending: false, error: null, done: 1 });
    assert.equal(toasts(store).at(-1)?.title, 'Published');
    assert.equal(store.getState().apps.eventSeq, 501n);

    // The mirror: a late unpublish answer against a newer publication under another slug.
    store.dispatch(unpublishApp('apps/kcal'));
    assert.deepEqual(selectAppCall(store.getState(), 'apps/kcal'), { kind: 'unpublish', since: 501n });
    store.dispatch(eventAction(event({ type: 'app.unpublished', actor: 'user', payload: { path: 'apps/kcal', slug: 'kcal' } })));
    store.dispatch(eventAction(event({ type: 'app.published', actor: 'user', payload: { path: 'apps/kcal', slug: 'kcal-2', name: 'Calorie tracker', description: null } })));
    assert.equal(row(store, 'apps/kcal')?.slug, 'kcal-2');
    answers[1].resolve({ path: 'apps/kcal', slug: 'kcal' });
    await settle();
    assert.equal(row(store, 'apps/kcal')?.slug, 'kcal-2');
    assert.equal(selectAppCall(store.getState(), 'apps/kcal'), null);
    assert.equal(toasts(store).at(-1)?.title, 'Unpublished');

    // An event of another app during the call: the answer is not folded either — the call's own event is on its way and brings the row.
    store.dispatch(publishApp('b/tracker', 'tracker'));
    store.dispatch(eventAction(event({ type: 'app.published', actor: 'user', payload: { path: 'z/other', slug: 'other', name: null, description: null } })));
    answers[2].resolve({ path: 'b/tracker', slug: 'tracker' });
    await settle();
    assert.equal(row(store, 'b/tracker')?.slug, null);
    assert.deepEqual(selectAppPublish(store.getState(), 'b/tracker'), { pending: false, error: null, done: 2 });
    store.dispatch(eventAction(event({ type: 'app.published', actor: 'user', payload: { path: 'b/tracker', slug: 'tracker', name: 'Tracker', description: null } })));
    assert.equal(row(store, 'b/tracker')?.slug, 'tracker');

    // Without a newer event the answer is the freshest word and is folded (the tail may be reconnecting).
    store.dispatch(unpublishApp('b/tracker'));
    answers[3].resolve({ path: 'b/tracker', slug: 'tracker' });
    await settle();
    assert.equal(row(store, 'b/tracker')?.slug, null);
  });

  it('serves app folders named like the keys of Object.prototype', async () => {
    const calls: Calls = [];
    const PROTO = ['constructor', 'toString', '__proto__', 'hasOwnProperty'].map(path => ({ path, name: null, description: null, manifestError: null, slug: null }));
    const store = await onApps({ snapshot: async () => snapshot({ apps: listing(PROTO) }) }, calls);

    for (const { path } of PROTO) {
      assert.equal(selectAppCall(store.getState(), path), null, path);
      assert.deepEqual(selectAppPublish(store.getState(), path), { pending: false, error: null, done: 0 }, path);

      await dispatched(store, publishApp(path, 'x'));
      await settle();
      assert.equal(row(store, path)?.slug, 'x', path);
      assert.equal(selectAppCall(store.getState(), path), null, path);
      assert.deepEqual(selectAppPublish(store.getState(), path), { pending: false, error: null, done: 1 }, path);

      await dispatched(store, unpublishApp(path));
      await settle();
      assert.equal(row(store, path)?.slug, null, path);
      assert.equal(selectAppCall(store.getState(), path), null, path);
    }

    assert.equal(calls.filter(call => call.name === 'apps.publish').length, PROTO.length);
    assert.equal(calls.filter(call => call.name === 'apps.unpublish').length, PROTO.length);
    assert.deepEqual(Object.keys(store.getState().apps.calls), []);
  });
});

describe('apps listing', () => {
  const TRACKER = { path: 'b/tracker', name: 'Tracker', description: null, manifestError: null, slug: null };
  const NEW_FOLDER = { path: 'a/new', name: 'New', description: 'written after the snapshot', manifestError: null, slug: null };
  const listing = (apps: AppsResponse['apps']): AppsResponse => ({ apps, publicAppsBase: 'https://apps.example' });
  const listCalls = (calls: Calls) => calls.filter(call => call.name === 'apps.list').length;

  type Answer = { resolve: (apps: AppsResponse) => void; reject: (error: unknown) => void };

  // A listing that answers by hand: every call is one entry, settled by the test.
  const heldList = (answers: Answer[]) => () =>
    new Promise<AppsResponse>((resolve, reject) => {
      answers.push({ resolve, reject });
    });

  async function onApps(overrides: ApiOverrides = {}, calls: Calls = []): Promise<AppStore> {
    const store = createStore({ api: fakeApi({ snapshot: async () => snapshot({ apps: listing([TRACKER]) }), ...overrides }, calls), initialRoute: { key: 'apps' } });

    await dispatched(store, sessionCheck());
    await settle();

    return store;
  }

  it('reads the listing again on entering the screen and on the tab coming back, not for the snapshot that just brought the rows', async () => {
    const calls: Calls = [];
    const store = await onApps({ apps: { list: async () => listing([NEW_FOLDER, TRACKER]) } }, calls);

    // The tab opened on /apps: the snapshot's rows are the data, no second read.
    assert.deepEqual(store.getState().apps.items, [TRACKER]);
    assert.equal(listCalls(calls), 0);

    store.dispatch(routeTo({ key: 'home' }));
    assert.equal(listCalls(calls), 0);

    await dispatched(store, routeTo({ key: 'apps' }));
    await settle();
    assert.equal(listCalls(calls), 1);
    assert.deepEqual(store.getState().apps.items, [NEW_FOLDER, TRACKER]);
    assert.deepEqual(store.getState().apps.refresh, { request: null, error: null });

    await dispatched(store, tabVisible());
    await settle();
    assert.equal(listCalls(calls), 2);

    store.dispatch(routeTo({ key: 'home' }));
    await dispatched(store, tabVisible());
    await settle();
    assert.equal(listCalls(calls), 2);
  });

  it('narrows the rows in the browser when the segment or the search changes within the screen: no read', async () => {
    const calls: Calls = [];
    const store = await onApps({ apps: { list: async () => listing([NEW_FOLDER, TRACKER]) } }, calls);

    // Typing into the search, switching the segment, resetting the filters,
    // the route it already shows: the rows are the ones it has.
    for (const route of [
      { key: 'apps', q: 't' },
      { key: 'apps', q: 'tr' },
      { key: 'apps', q: 'tr', filter: 'published' },
      { key: 'apps' },
      { key: 'apps' },
    ] as const) {
      await dispatched(store, routeTo(route, { replace: true }));
      await settle();
    }

    assert.equal(listCalls(calls), 0);
    assert.deepEqual(store.getState().apps.items, [TRACKER]);

    // From another section it is an entry; a filter after it is not.
    store.dispatch(routeTo({ key: 'home' }));
    await dispatched(store, routeTo({ key: 'apps', filter: 'errors' }));
    await settle();
    assert.equal(listCalls(calls), 1);
    await dispatched(store, routeTo({ key: 'apps', q: 'new' }, { replace: true }));
    await settle();
    assert.equal(listCalls(calls), 1);

    // The tab's return and a Retry read whatever the filters are.
    await dispatched(store, tabVisible());
    await settle();
    assert.equal(listCalls(calls), 2);
    await dispatched(store, loadApps());
    await settle();
    assert.equal(listCalls(calls), 3);
  });

  it('keeps the rows as they are when the listing changed nothing, and one read at a time', async () => {
    const calls: Calls = [];
    const answers: Answer[] = [];
    const store = await onApps({ apps: { list: heldList(answers) } }, calls);
    const before = store.getState().apps.items;

    store.dispatch(loadApps());
    store.dispatch(loadApps());
    assert.equal(listCalls(calls), 1);
    assert.notEqual(store.getState().apps.refresh.request, null);

    answers[0].resolve(listing([{ ...TRACKER }]));
    await settle();
    assert.equal(store.getState().apps.items, before);
    assert.equal(store.getState().apps.refresh.request, null);
  });

  it('keeps the rows and records the failure of a re-read; Retry reads again', async () => {
    const calls: Calls = [];
    let fail = true;
    const store = await onApps(
      {
        apps: {
          list: async () => {
            if (fail) {
              throw new ApiError(503, 'unavailable', 'down');
            }

            return listing([NEW_FOLDER, TRACKER]);
          },
        },
      },
      calls,
    );

    await dispatched(store, loadApps());
    await settle();
    assert.deepEqual(store.getState().apps.items, [TRACKER]);
    assert.deepEqual(store.getState().apps.refresh, { request: null, error: { status: 503, code: 'unavailable', message: 'down' } });

    fail = false;
    await dispatched(store, loadApps());
    await settle();
    assert.deepEqual(store.getState().apps.items, [NEW_FOLDER, TRACKER]);
    assert.deepEqual(store.getState().apps.refresh, { request: null, error: null });
  });

  it('does not apply a listing that an app event may have outrun, and reads once more after it', async () => {
    resetSeq(360n);

    const calls: Calls = [];
    const answers: Answer[] = [];
    const store = await onApps({ apps: { list: heldList(answers) } }, calls);

    store.dispatch(loadApps());
    assert.equal(answers.length, 1);
    assert.deepEqual(store.getState().apps.refresh.request, { since: null, changes: 0 });

    // Published while the listing was in flight: the row knows the slug.
    store.dispatch(eventAction(event({ type: 'app.published', actor: 'user', payload: { path: 'b/tracker', slug: 'tracker', name: 'Tracker', description: null } })));
    assert.equal(store.getState().apps.items[0].slug, 'tracker');
    assert.equal(store.getState().apps.eventSeq, 360n);

    // The answer was read before the publish: it is not applied, the listing is asked for again from after the event.
    answers[0].resolve(listing([NEW_FOLDER, TRACKER]));
    await settle();
    assert.deepEqual(store.getState().apps.items, [{ ...TRACKER, slug: 'tracker' }]);
    assert.equal(answers.length, 2);
    assert.deepEqual(store.getState().apps.refresh.request, { since: 360n, changes: 0 });

    answers[1].resolve(listing([NEW_FOLDER, { ...TRACKER, slug: 'tracker' }]));
    await settle();
    assert.deepEqual(store.getState().apps.items, [NEW_FOLDER, { ...TRACKER, slug: 'tracker' }]);
    assert.equal(answers.length, 2);
    assert.equal(store.getState().apps.refresh.request, null);

    // An event that changes no row still dates the rows — the listing in
    // flight at that moment could predate it; the rows keep their identity.
    const rows = store.getState().apps.items;

    store.dispatch(eventAction(event({ type: 'app.published', actor: 'user', payload: { path: 'b/tracker', slug: 'tracker', name: 'Tracker', description: null } })));
    assert.equal(store.getState().apps.eventSeq, 361n);
    assert.equal(store.getState().apps.items, rows);

    // A replayed seq (the overlap of a reconnection) does not move the stamp back.
    store.dispatch(eventAction(event({ seq: 360n, type: 'app.published', actor: 'user', payload: { path: 'b/tracker', slug: 'tracker', name: 'Tracker', description: null } })));
    assert.equal(store.getState().apps.eventSeq, 361n);
  });

  it('dates the rows on an unpublish of a folder they do not know: the listing in flight brought the publication and is not applied', async () => {
    resetSeq(400n);

    const calls: Calls = [];
    const answers: Answer[] = [];
    const store = await onApps({ apps: { list: heldList(answers) } }, calls);
    // A published app whose folder was away when the snapshot was read
    // (the listing skips it; the publication row stays) and is back now:
    // the read in flight lists it with its slug.
    const RESTORED = { path: 'c/restored', name: 'Restored', description: null, manifestError: null, slug: 'restored' };

    store.dispatch(loadApps());
    assert.equal(answers.length, 1);

    // Unpublished while the listing was in flight: no row to change, but the rows are dated.
    store.dispatch(eventAction(event({ type: 'app.unpublished', actor: 'user', payload: { path: 'c/restored', slug: 'restored' } })));
    assert.equal(store.getState().apps.eventSeq, 400n);
    assert.deepEqual(store.getState().apps.items, [TRACKER]);

    // The answer predates the event: the publication it carries is gone.
    answers[0].resolve(listing([TRACKER, RESTORED]));
    await settle();
    assert.deepEqual(store.getState().apps.items, [TRACKER]);
    assert.equal(answers.length, 2);
    assert.deepEqual(store.getState().apps.refresh.request, { since: 400n, changes: 0 });

    answers[1].resolve(listing([TRACKER, { ...RESTORED, slug: null }]));
    await settle();
    assert.deepEqual(store.getState().apps.items, [TRACKER, { ...RESTORED, slug: null }]);
    assert.equal(store.getState().apps.refresh.request, null);
  });

  it('drops the answer of a read that outlives the session', async () => {
    const calls: Calls = [];
    const answers: Answer[] = [];
    const store = await onApps({ apps: { list: heldList(answers) } }, calls);

    store.dispatch(loadApps());
    store.dispatch(sessionLost());
    answers[0].resolve(listing([NEW_FOLDER]));
    await settle();
    assert.deepEqual(store.getState().apps.items, []);
    assert.equal(store.getState().apps.refresh.request, null);
  });

  it('drops the answer and the failure of the previous session\'s read after the next sign-in, and keeps the new session\'s read in flight', async () => {
    const calls: Calls = [];
    const answers: Answer[] = [];
    const FRESH = { path: 'f/fresh', name: 'Fresh', description: null, manifestError: null, slug: null };
    const STALE = { path: 'f/fresh', name: 'Stale', description: null, manifestError: null, slug: null };
    let rows = [TRACKER];
    const store = await onApps({ apps: { list: heldList(answers) }, snapshot: async () => snapshot({ apps: listing(rows) }) }, calls);

    // The read of the first session hangs; the session is lost and a new one
    // signs in with its own snapshot — both sessions stand at eventSeq null.
    store.dispatch(loadApps());
    store.dispatch(sessionLost());
    rows = [FRESH];
    await dispatched(store, sessionCheck());
    await settle();
    assert.deepEqual(store.getState().apps.items, [FRESH]);

    // The new session's own read is in flight when the old answer lands.
    store.dispatch(loadApps());
    assert.equal(answers.length, 2);

    const current = store.getState().apps.refresh.request;

    answers[0].resolve(listing([STALE]));
    await settle();
    assert.deepEqual(store.getState().apps.items, [FRESH]);
    assert.equal(store.getState().apps.refresh.request, current);

    // Still one read at a time: the old answer freed nothing.
    store.dispatch(loadApps());
    assert.equal(answers.length, 2);

    answers[1].resolve(listing([NEW_FOLDER, FRESH]));
    await settle();
    assert.deepEqual(store.getState().apps.items, [NEW_FOLDER, FRESH]);
    assert.equal(store.getState().apps.refresh.request, null);

    // The same for a failure of the old read: no error lands in the new session.
    store.dispatch(loadApps());
    store.dispatch(sessionLost());
    await dispatched(store, sessionCheck());
    await settle();
    store.dispatch(loadApps());
    assert.equal(answers.length, 4);

    const later = store.getState().apps.refresh.request;

    answers[2].reject(new ApiError(503, 'unavailable', 'down'));
    await settle();
    assert.deepEqual(store.getState().apps.refresh, { request: later, error: null });

    answers[3].resolve(listing([FRESH]));
    await settle();
    assert.deepEqual(store.getState().apps.refresh, { request: null, error: null });
  });
});
