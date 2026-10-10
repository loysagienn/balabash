// The stream process over the real store with a fake EventSource: the
// first opening, the browser's own reconnection, the give-up (CLOSED) with
// its pause, what the store says all along — "reconnecting" until the tail
// flows again — and the close at the end of a session.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import { stringifyJson } from '../../../utils/serialize-json.ts';
import type { Api } from '../api/index.ts';
import { createStore } from '../../store/index.ts';
import type { AppStore } from '../../store/index.ts';
import { sessionCheck, sessionLost } from '../../store/session/actions.ts';
import { ME, event, snapshot, thread } from '../../store/fixtures.ts';
import { RETRY_AFTER_MS, STREAM_PATH, connectStoreToStream } from './index.ts';

class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];

  readonly url: string;
  readyState = FakeEventSource.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((message: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  close() {
    this.readyState = FakeEventSource.CLOSED;
  }

  // The browser's hand: the connection opened, a frame came, the connection
  // broke (the browser retries by itself, readyState CONNECTING) or the
  // browser gave up (readyState CLOSED).
  opened() {
    this.readyState = FakeEventSource.OPEN;
    this.onopen?.();
  }

  frame(seq: bigint) {
    this.onmessage?.({ data: stringifyJson(event({ seq, type: 'thread.progress', threadId: 'a', payload: { text: 'working' } })) });
  }

  broke() {
    this.readyState = FakeEventSource.CONNECTING;
    this.onerror?.();
  }

  gaveUp() {
    this.readyState = FakeEventSource.CLOSED;
    this.onerror?.();
  }
}

const api: Api = {
  me: async () => ME,
  auth: async () => ME,
  consoleCode: async () => null,
  logout: async () => ({ ok: true as const }),
  snapshot: async () => snapshot({ asOfSeq: 50n, threads: [thread({ id: 'main', parentId: null }), thread({ id: 'a', createdSeq: 7n })] }),
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
    get: async () => ({ thread: thread({ id: 'a' }) }),
    events: async () => ({ events: [], nextCursor: null }),
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

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

// The process's clock: the moment it stamps when the tail stops flowing.
// The tests move it by hand (`clock.now`) so that a stamp kept is told from
// a stamp written again with the same value.
const BROKE_AT = new Date('2026-10-10T16:31:00.000Z');
const STILL_DOWN_AT = new Date('2026-10-10T16:40:00.000Z');
const BROKE_AGAIN_AT = new Date('2026-10-10T17:05:00.000Z');

// A signed-in store with its snapshot landed and the process attached: the
// first EventSource is open on the tail. Timers are mocked from here on, so
// the retry pause is driven by hand.
async function connected(t: TestContext): Promise<{ store: AppStore; first: FakeEventSource; status: () => string; sources: () => FakeEventSource[]; clock: { now: Date } }> {
  FakeEventSource.instances = [];
  (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;
  t.after(() => {
    delete (globalThis as { EventSource?: unknown }).EventSource;
  });

  const clock = { now: BROKE_AT };
  const store = createStore({ api, initialRoute: { key: 'home' } });
  const disconnect = connectStoreToStream(store, { now: () => clock.now });

  t.after(disconnect);
  store.dispatch(sessionCheck());
  await settle();
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const sources = () => FakeEventSource.instances;
  const status = () => store.getState().stream.status;

  assert.equal(sources().length, 1);
  assert.equal(sources()[0].url, `${STREAM_PATH}?after=50`);
  assert.equal(status(), 'connecting');

  const first = sources()[0];

  first.opened();
  assert.equal(status(), 'open');
  assert.equal(store.getState().stream.dataAt, null);
  first.frame(52n);
  assert.equal(store.getState().stream.lastSeq, 52n);

  return { store, first, status, sources, clock };
}

describe('stream process', () => {
  it("says reconnecting while the browser retries by itself, open once it is back", async t => {
    const { store, first, status, sources } = await connected(t);

    first.broke();
    assert.equal(status(), 'reconnecting');
    assert.equal(sources().length, 1);
    // The data is known current up to the break — the first one of the outage.
    assert.equal(store.getState().stream.dataAt, BROKE_AT);

    first.opened();
    assert.equal(status(), 'open');
    assert.equal(store.getState().stream.dataAt, null);
  });

  it('names no moment when the tail never opened: the snapshot is the data', async t => {
    FakeEventSource.instances = [];
    (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;
    t.after(() => {
      delete (globalThis as { EventSource?: unknown }).EventSource;
    });

    const store = createStore({ api, initialRoute: { key: 'home' } });

    t.after(connectStoreToStream(store, { now: () => BROKE_AT }));
    store.dispatch(sessionCheck());
    await settle();
    assert.equal(store.getState().stream.status, 'connecting');

    FakeEventSource.instances[0].broke();
    assert.equal(store.getState().stream.status, 'reconnecting');
    assert.equal(store.getState().stream.dataAt, null);
  });

  it('waits out the pause after a give-up and keeps saying reconnecting until the reopened tail flows', async t => {
    const { store, first, status, sources, clock } = await connected(t);

    first.gaveUp();
    assert.equal(status(), 'reconnecting');
    assert.equal(store.getState().stream.dataAt, BROKE_AT);
    // Not reopened at once: the dispatch of "reconnecting" woke the process, which saw the pending retry.
    assert.equal(sources().length, 1);
    assert.equal(first.readyState, FakeEventSource.CLOSED);

    t.mock.timers.tick(RETRY_AFTER_MS - 1);
    assert.equal(sources().length, 1);

    t.mock.timers.tick(1);
    assert.equal(sources().length, 2);
    // From the last seq seen, and still the warning: the attempt is not the recovery.
    assert.equal(sources()[1].url, `${STREAM_PATH}?after=52`);
    assert.equal(status(), 'reconnecting');

    // The server is still down: the next attempt waits the pause again; the
    // moment stays the first break's while the process's clock has moved on.
    clock.now = STILL_DOWN_AT;
    sources()[1].gaveUp();
    assert.equal(status(), 'reconnecting');
    assert.equal(store.getState().stream.dataAt, BROKE_AT);
    assert.equal(sources().length, 2);
    t.mock.timers.tick(RETRY_AFTER_MS);
    assert.equal(sources().length, 3);
    assert.equal(status(), 'reconnecting');

    sources()[2].opened();
    assert.equal(status(), 'open');
    assert.equal(store.getState().stream.dataAt, null);
    sources()[2].frame(53n);
    assert.equal(sources()[2].readyState, FakeEventSource.OPEN);

    // The next outage is its own: the moment is the new break's.
    clock.now = BROKE_AGAIN_AT;
    sources()[2].broke();
    assert.equal(status(), 'reconnecting');
    assert.equal(store.getState().stream.dataAt, BROKE_AGAIN_AT);
  });

  it('closes for good when the session ends during the pause', async t => {
    const { store, first, status, sources } = await connected(t);

    first.gaveUp();
    store.dispatch(sessionLost());
    assert.equal(status(), 'idle');

    t.mock.timers.tick(RETRY_AFTER_MS);
    assert.equal(sources().length, 1);
    assert.equal(status(), 'idle');
  });

  it('ignores a source it has already replaced', async t => {
    const { first, status, sources } = await connected(t);

    first.gaveUp();
    t.mock.timers.tick(RETRY_AFTER_MS);
    sources()[1].opened();
    assert.equal(status(), 'open');

    // The old source's hand no longer reaches the store.
    first.broke();
    assert.equal(status(), 'open');
  });
});
