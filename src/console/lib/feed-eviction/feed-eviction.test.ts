// The eviction process over the real store with a fake Api and a clock
// driven by hand: which feeds are in use (shown, running, the main
// thread's), when a feed out of use is due, what a late frame of the tail
// does to an evicted thread, and the silence after disconnecting.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import type { Event } from '../../../core/contract.ts';
import { feedThreadIds } from '../../../projections/feed.ts';
import type { Api } from '../api/index.ts';
import { createStore } from '../../store/index.ts';
import type { AppStore } from '../../store/index.ts';
import { eventAction } from '../../store/events.ts';
import { routeTo } from '../../store/router/actions.ts';
import { sessionCheck } from '../../store/session/actions.ts';
import { loadThreadEvents } from '../../store/threads/actions.ts';
import { ME, event, resetSeq, snapshot, thread } from '../../store/fixtures.ts';
import { FEED_SWEEP_MS, FEED_TTL_MS, connectStoreToFeedEviction, evictableFeeds } from './index.ts';

const MINUTE = 60_000;

const api: Api = {
  me: async () => ME,
  auth: async () => ME,
  consoleCode: async () => null,
  logout: async () => ({ ok: true as const }),
  connections: {
    rename: async () => {
      throw new Error('not here');
    },
    disconnect: async () => {
      throw new Error('not here');
    },
    reconnect: async () => {
      throw new Error('not here');
    },
    connect: async () => {
      throw new Error('not here');
    },
  },
  snapshot: async () =>
    snapshot({
      asOfSeq: 50n,
      threads: [
        thread({ id: 'main', parentId: null, agent: 'coordinator' }),
        thread({ id: 'running', createdSeq: 7n }),
        thread({ id: 'done', createdSeq: 8n, status: 'completed', terminalSeq: 20n }),
        thread({ id: 'other', createdSeq: 9n, status: 'completed', terminalSeq: 21n }),
      ],
    }),
  settings: {
    get: async () => {
      throw new Error('not here');
    },
    update: async () => ({ settings: { workspaceName: 'Workspace', operatorName: null }, seq: null }),
  },
  apps: {
    list: async () => ({ apps: [], publicAppsBase: '' }),
    publish: async () => {
      throw new Error('not here');
    },
    unpublish: async () => {
      throw new Error('not here');
    },
  },
  projects: {
    create: async () => {
      throw new Error('not here');
    },
    update: async () => {
      throw new Error('not here');
    },
    archive: async () => {
      throw new Error('not here');
    },
    unarchive: async () => {
      throw new Error('not here');
    },
  },
  threads: {
    list: async () => ({ threads: [], nextCursor: null }),
    get: async () => ({ thread: thread({ id: 'done' }) }),
    // One chunk for any thread: the thread's start, nothing older.
    events: async (threadId, query) => ({ events: query.before === undefined || query.before > started(threadId).seq ? [started(threadId)] : [], nextCursor: null }),
    sendMessage: async () => ({}),
    interrupt: async () => ({}),
    cancel: async () => ({}),
  },
  workspace: {
    node: async () => ({ kind: 'dir', path: '', directories: [], folders: [], files: [] }),
    text: async () => ({ text: '', etag: null }),
    write: async () => {
      throw new Error('not here');
    },
  },
  files: {
    meta: async () => {
      throw new Error('not here');
    },
  },
  llmRequests: { list: async () => ({ requests: [] }) },
  limits: { get: async () => ({ claude: { limits: null, lastFailure: null, liveSessions: 0, lastSessionAt: null }, codex: { limits: null, lastFailure: null } }) },
  schedule: {
    runs: async () => ({ runs: [], nextCursor: null }),
    latestRuns: async () => ({ runs: [] }),
    run: async () => {
      throw new Error('not here');
    },
    runTask: async () => {
      throw new Error('not here');
    },
    deleteTask: async () => {
      throw new Error('not here');
    },
  },
  secretRequests: {
    get: async () => {
      throw new Error('not here');
    },
    provision: async () => {
      throw new Error('not here');
    },
  },
};

const started = (threadId: string) => event({ type: 'thread.started', seq: threadId === 'done' ? 8n : 9n, threadId, payload: { agent: 'engineer' } });

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

// The server's side of the log for one test: the frames the tail brought
// (recorded by `frame`) are on the server too, and a chunk asked below
// `before` returns them with the thread's start, newest down — after the
// test lets the answer go (`hold`), so a frame of the tail can land while
// the request is in flight.
function server(): { log: Event[]; events: Api['threads']['events']; requests: Array<bigint | undefined>; hold: () => () => void } {
  const log: Event[] = [];
  const requests: Array<bigint | undefined> = [];
  let gate: Promise<void> | null = null;

  return {
    log,
    requests,
    hold: () => {
      let release = () => {};

      gate = new Promise(resolve => {
        release = () => {
          gate = null;
          resolve();
        };
      });

      return release;
    },
    events: async (threadId, query) => {
      requests.push(query.before);
      await gate;

      const before = query.before ?? null;
      const page = [started(threadId), ...log.filter(item => feedThreadIds(item).includes(threadId))].filter(item => before === null || item.seq < before);

      return { events: page.sort((a, b) => (a.seq < b.seq ? 1 : -1)), nextCursor: null };
    },
  };
}

// A signed-in store with its snapshot landed and the process attached under
// mocked timers and a clock the test moves (`clock.now`, ms).
async function connected(t: TestContext, events: Api['threads']['events'] = api.threads.events): Promise<{ store: AppStore; clock: { now: number }; feeds: () => string[]; sweep: (times?: number) => void; disconnect: () => void }> {
  resetSeq(51n);

  const clock = { now: 1_000_000 };
  const store = createStore({ api: { ...api, threads: { ...api.threads, events } }, initialRoute: { key: 'home' } });

  store.dispatch(sessionCheck());
  await settle();
  assert.equal(store.getState().stream.asOfSeq, 50n);

  t.mock.timers.enable({ apis: ['setInterval'] });

  const disconnect = connectStoreToFeedEviction(store, { now: () => clock.now });

  t.after(disconnect);

  // Moving the clock by one sweep and letting the sweep run.
  const sweep = (times = 1) => {
    for (let i = 0; i < times; i += 1) {
      clock.now += FEED_SWEEP_MS;
      t.mock.timers.tick(FEED_SWEEP_MS);
    }
  };

  return { store, clock, feeds: () => Object.keys(store.getState().feed.byThread).sort(), sweep, disconnect };
}

// A frame of the tail for the store; `log` is the server that has it too.
function frame(threadId: string, log: Event[] = []) {
  const item = event({ type: 'thread.progress', threadId, targetThreadId: null, payload: { text: 'working' } });

  log.push(item);

  return eventAction(item);
}

describe('feed eviction process', () => {
  it('evicts the feed of a finished thread once it has been out of use for the TTL, not before', async t => {
    const { store, feeds, sweep } = await connected(t);

    store.dispatch(frame('done'));
    store.dispatch(frame('other'));
    assert.deepEqual(feeds(), ['done', 'other']);

    sweep(FEED_TTL_MS / MINUTE - 1);
    assert.deepEqual(feeds(), ['done', 'other']);

    // A frame of the tail is a use: that feed's clock starts over — one
    // sweep before the sweep that takes the other feed.
    store.dispatch(frame('other'));
    sweep();
    assert.deepEqual(feeds(), ['other']);
    assert.equal(store.getState().feed.events['51'], undefined);

    sweep(FEED_TTL_MS / MINUTE - 2);
    assert.deepEqual(feeds(), ['other']);
    sweep();
    assert.deepEqual(feeds(), []);
    assert.deepEqual(store.getState().feed.events, {});
  });

  it('keeps the feeds in use: the thread on screen, a running thread, the main thread', async t => {
    const { store, feeds, sweep } = await connected(t);

    store.dispatch(routeTo({ key: 'thread', id: 'done' }));
    await settle();
    assert.deepEqual(store.getState().feed.byThread.done.seqs, ['8']);

    store.dispatch(frame('running'));
    store.dispatch(frame('main'));
    store.dispatch(frame('other'));
    assert.deepEqual(feeds(), ['done', 'main', 'other', 'running']);

    sweep(FEED_TTL_MS / MINUTE + 1);
    assert.deepEqual(feeds(), ['done', 'main', 'running']);

    // The thread left: its reading period starts when the reading ends.
    store.dispatch(routeTo({ key: 'home' }));
    sweep(FEED_TTL_MS / MINUTE - 1);
    assert.deepEqual(feeds(), ['done', 'main', 'running']);
    sweep();
    assert.deepEqual(feeds(), ['main', 'running']);

    // The running thread ends: its feed is due the TTL after its last frame.
    store.dispatch(eventAction(event({ type: 'thread.completed', threadId: 'running', targetThreadId: 'main', payload: { summary: { text: 'done' } } })));
    assert.equal(store.getState().threads.byId.running.status, 'completed');
    sweep(FEED_TTL_MS / MINUTE - 1);
    assert.deepEqual(feeds(), ['main', 'running']);
    sweep();
    assert.deepEqual(feeds(), ['main']);
    // The end was the main thread's too: it stays with the main feed.
    assert.deepEqual(store.getState().feed.byThread.main.seqs, ['52', '54']);
  });

  it('does not evict a feed with a chunk in flight; the answer is a use, and the clock starts over from it', async t => {
    const { log, events, hold } = server();
    const { store, feeds, sweep } = await connected(t, events);
    const release = hold();

    store.dispatch(frame('done', log));
    store.dispatch(loadThreadEvents('done', null));
    store.dispatch(routeTo({ key: 'home' }));
    assert.notEqual(store.getState().feed.byThread.done.request, null);
    sweep(FEED_TTL_MS / MINUTE + 1);
    assert.deepEqual(feeds(), ['done']);

    // The answer lands: the feed is complete from the start, and due a TTL
    // after the answer — not at the next sweep.
    release();
    await settle();
    assert.equal(store.getState().feed.byThread.done.request, null);
    assert.deepEqual(store.getState().feed.byThread.done.seqs, ['8', '51']);
    sweep(FEED_TTL_MS / MINUTE - 1);
    assert.deepEqual(feeds(), ['done']);
    sweep();
    assert.deepEqual(feeds(), []);
  });

  it('an evicted thread opened again loads from the head: the evicted frame comes back with the chunk, and a frame during the request merges in', async t => {
    const { log, events, requests, hold } = server();
    const { store, feeds, sweep } = await connected(t, events);

    store.dispatch(frame('done', log));
    sweep(FEED_TTL_MS / MINUTE);
    assert.deepEqual(feeds(), []);
    assert.deepEqual(store.getState().feed.events, {});

    // The chunk is asked from the seq after the tail's last (51): the
    // evicted frame is the chunk's to bring back. A frame of the tail
    // while the answer is in flight starts the feed with the request on.
    const release = hold();

    store.dispatch(routeTo({ key: 'thread', id: 'done' }));
    await settle();
    assert.deepEqual(requests, [52n]);
    store.dispatch(frame('done', log));
    assert.deepEqual(store.getState().feed.byThread.done.seqs, ['52']);
    assert.notEqual(store.getState().feed.byThread.done.request, null);

    release();
    await settle();
    assert.deepEqual(requests, [52n]);
    assert.deepEqual(store.getState().feed.byThread.done, { seqs: ['8', '51', '52'], knownFrom: 8n, exhausted: true, request: null, error: null });
    assert.deepEqual(Object.keys(store.getState().feed.events).sort(), ['51', '52', '8']);

    // Left again, the feed goes with everything it listed.
    store.dispatch(routeTo({ key: 'home' }));
    sweep(FEED_TTL_MS / MINUTE);
    assert.deepEqual(feeds(), []);
    assert.deepEqual(store.getState().feed.events, {});
  });

  it('is silent once disconnected', async t => {
    const { store, feeds, sweep, disconnect } = await connected(t);

    store.dispatch(frame('done'));
    disconnect();
    sweep(FEED_TTL_MS / MINUTE + 1);
    assert.deepEqual(feeds(), ['done']);
  });

  it('evictableFeeds: a feed without a reading is not due, a reading at the deadline is', async t => {
    const { store } = await connected(t);

    store.dispatch(frame('done'));
    store.dispatch(frame('other'));
    assert.deepEqual(evictableFeeds(store.getState(), new Map([['done', 5]]), 5), ['done']);
    assert.deepEqual(evictableFeeds(store.getState(), new Map([['done', 6]]), 5), []);
    assert.deepEqual(evictableFeeds(store.getState(), new Map([['done', 1], ['other', 1]]), 5), ['done', 'other']);
  });
});
