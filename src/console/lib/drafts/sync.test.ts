// The draft sync process over the real store with a fake Api and mocked
// timers: a save once the typing rests (every edit starts the pause
// again), in any case within the maximum wait, at once with keepalive when
// the tab goes out of view; nothing while a conflict waits for the user;
// after a failure only an edit or the tab's return starts the clocks
// again.
//
// Run: npm test  (node:test, native type stripping).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TestContext } from 'node:test';
import type { Api } from '../api/index.ts';
import { ApiError } from '../api/index.ts';
import { createStore } from '../../store/index.ts';
import type { AppStore } from '../../store/index.ts';
import { sessionCheck } from '../../store/session/actions.ts';
import { setComposerDraft } from '../../store/ui/actions.ts';
import { sendMessage } from '../../store/threads/actions.ts';
import { tabVisible } from '../../store/router/actions.ts';
import { ME, snapshot, thread } from '../../store/fixtures.ts';
import { DEBOUNCE_MS, MAX_WAIT_MS, connectStoreToDraftSync } from './index.ts';
import type { DraftSyncDocument, DraftSyncWindow } from './index.ts';

type Save = { text: string; baseRevision: number; keepalive: boolean };

class FakeDocument implements DraftSyncDocument {
  visibilityState: DocumentVisibilityState = 'visible';
  private listeners = new Set<() => void>();

  addEventListener(_type: 'visibilitychange', listener: () => void) {
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'visibilitychange', listener: () => void) {
    this.listeners.delete(listener);
  }

  hide() {
    this.visibilityState = 'hidden';
    this.listeners.forEach(listener => listener());
  }
}

class FakeWindow implements DraftSyncWindow {
  private listeners = new Set<() => void>();

  addEventListener(_type: 'pagehide', listener: () => void) {
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'pagehide', listener: () => void) {
    this.listeners.delete(listener);
  }

  leave() {
    this.listeners.forEach(listener => listener());
  }
}

const flush = () => new Promise(resolve => setImmediate(resolve));

async function connected(t: TestContext): Promise<{ store: AppStore; saves: Save[]; server: { revision: number; fail: boolean; conflict: boolean; holdSend: Promise<void> | null }; doc: FakeDocument; win: FakeWindow }> {
  const saves: Save[] = [];
  const server: { revision: number; fail: boolean; conflict: boolean; holdSend: Promise<void> | null } = { revision: 0, fail: false, conflict: false, holdSend: null };
  const api = {
    me: async () => ME,
    snapshot: async () => snapshot({ threads: [thread({ id: 't1' })] }),
    threads: {
      get: async () => ({ thread: thread({ id: 't1' }) }),
      events: async () => ({ events: [], nextCursor: null }),
      list: async () => ({ threads: [], nextCursor: null }),
      draft: async () => ({ draft: null }),
      sendMessage: async () => {
        await server.holdSend;
        server.revision++;

        return {};
      },
      saveDraft: async (id: string, content: { text: string; fileIds: string[] }, baseRevision: number, options?: { keepalive?: boolean }) => {
        saves.push({ text: content.text, baseRevision, keepalive: options?.keepalive ?? false });

        if (server.fail) {
          throw new TypeError('Failed to fetch');
        }

        if (server.conflict) {
          throw new ApiError(409, 'draft_conflict', 'changed', undefined, { code: 'draft_conflict', message: 'changed', draft: { threadId: id, text: 'theirs', files: [], revision: 9, updatedAt: new Date(0) } });
        }

        server.revision++;

        return { draft: { threadId: id, text: content.text, files: [], revision: server.revision, updatedAt: new Date(0) } };
      },
    },
  } as unknown as Api;
  const store = createStore({ api, initialRoute: { key: 'thread', id: 't1' } });

  store.dispatch(sessionCheck());
  await flush();
  await flush();

  const doc = new FakeDocument();
  const win = new FakeWindow();

  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(connectStoreToDraftSync(store, {}, doc, win));

  return { store, saves, server, doc, win };
}

describe('draft sync process', () => {
  it('saves once the typing rests, every edit starting the pause again', async t => {
    const { store, saves } = await connected(t);

    store.dispatch(setComposerDraft('t1', 'D'));
    t.mock.timers.tick(DEBOUNCE_MS - 1);
    store.dispatch(setComposerDraft('t1', 'De'));
    t.mock.timers.tick(DEBOUNCE_MS - 1);
    assert.equal(saves.length, 0);

    t.mock.timers.tick(1);
    await flush();
    assert.deepEqual(saves, [{ text: 'De', baseRevision: 0, keepalive: false }]);

    // Nothing more to save: no second request.
    t.mock.timers.tick(MAX_WAIT_MS);
    await flush();
    assert.equal(saves.length, 1);
  });

  it('saves within the maximum wait while the typing never rests', async t => {
    const { store, saves } = await connected(t);

    for (let i = 1; i <= 5; i++) {
      store.dispatch(setComposerDraft('t1', 'x'.repeat(i)));
      t.mock.timers.tick(DEBOUNCE_MS - 1000);
    }

    // 20 s of typing without a 5 s pause: the maximum wait (15 s) fired once.
    await flush();
    assert.equal(saves.length, 1);
    assert.equal(saves[0]?.text, 'xxxx');

    // What came after is the next save, once the typing rests.
    t.mock.timers.tick(DEBOUNCE_MS);
    await flush();
    assert.equal(saves.length, 2);
    assert.equal(saves[1]?.text, 'xxxxx');
    assert.equal(saves[1]?.baseRevision, 1);
  });

  it('saves at once with keepalive when the tab goes out of view or the page is leaving', async t => {
    const { store, saves, doc, win } = await connected(t);

    store.dispatch(setComposerDraft('t1', 'on the phone'));
    doc.hide();
    await flush();
    assert.deepEqual(saves, [{ text: 'on the phone', baseRevision: 0, keepalive: true }]);

    // The clocks were cleared with the save: nothing fires later.
    t.mock.timers.tick(MAX_WAIT_MS);
    await flush();
    assert.equal(saves.length, 1);

    store.dispatch(setComposerDraft('t1', 'on the phone, closing'));
    win.leave();
    await flush();
    assert.equal(saves[1]?.keepalive, true);
    assert.equal(saves[1]?.text, 'on the phone, closing');
  });

  it('the clocks stop with a send: the pause ending or the tab hiding during it saves nothing; typed meanwhile is saved after the send', async t => {
    const { store, saves, server, doc } = await connected(t);
    let landSend = () => {};

    store.dispatch(setComposerDraft('t1', 'Hello'));
    t.mock.timers.tick(DEBOUNCE_MS - 1);
    server.holdSend = new Promise(resolve => (landSend = resolve));

    const sending = store.dispatch(sendMessage('t1', 'Hello')) as unknown as Promise<void>;

    // The pause ends and the tab hides while the send is in flight: the send settles the draft.
    t.mock.timers.tick(MAX_WAIT_MS);
    doc.hide();
    await flush();
    assert.equal(saves.length, 0);

    landSend();
    await sending;
    t.mock.timers.tick(MAX_WAIT_MS);
    await flush();
    assert.equal(saves.length, 0, 'sent whole: nothing left to save');

    store.dispatch(setComposerDraft('t1', 'Next'));
    t.mock.timers.tick(DEBOUNCE_MS);
    await flush();
    assert.deepEqual(saves, [{ text: 'Next', baseRevision: 0, keepalive: false }]);
  });

  it('nothing is saved while a conflict waits for the user, and nothing after a failure until an edit or the tab’s return', async t => {
    const { store, saves, server } = await connected(t);

    server.conflict = true;
    store.dispatch(setComposerDraft('t1', 'mine'));
    t.mock.timers.tick(DEBOUNCE_MS);
    await flush();
    assert.equal(saves.length, 1);
    assert.equal(store.getState().drafts.byThread.t1?.conflict?.text, 'theirs');

    store.dispatch(setComposerDraft('t1', 'mine, more'));
    t.mock.timers.tick(MAX_WAIT_MS);
    await flush();
    assert.equal(saves.length, 1, 'the question stands');

    // A failure: the content stays unsaved, the clocks stay quiet.
    server.conflict = false;
    server.fail = true;
    store.dispatch({ type: 'DRAFT_CONFLICT_KEEP_MINE', threadId: 't1' });
    t.mock.timers.tick(DEBOUNCE_MS);
    await flush();
    assert.equal(saves.length, 2);
    t.mock.timers.tick(MAX_WAIT_MS * 4);
    await flush();
    assert.equal(saves.length, 2, 'no retry every few seconds');

    // The tab's return: another go.
    server.fail = false;
    store.dispatch(tabVisible());
    t.mock.timers.tick(DEBOUNCE_MS);
    await flush();
    assert.equal(saves.length, 3);
    assert.equal(saves[2]?.baseRevision, 9);
    assert.equal(store.getState().drafts.byThread.t1?.failure, null);
  });
});
