// The drafts of the composer over the real store with a fake Api: the
// server's draft is read with the thread and applied to the composer while
// the tab has nothing unsaved; edits make the content unsaved and a save
// carries it over the revision the tab knows; what a refusal of the base
// means — the same text there (adopt), an empty draft there (saved again
// over the new revision), another text there (a conflict kept for the
// user: use theirs, or keep mine); the stream's frame reads the draft
// again only past the tab's revision; a sent message leaves what was typed
// meanwhile unsaved.
//
// Run: npm test  (node:test, native type stripping).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DraftView, StoredFileMeta } from '../../../api/contract.ts';
import type { Api } from '../../lib/api/index.ts';
import { ApiError } from '../../lib/api/index.ts';
import { createStore } from '../index.ts';
import type { AppStore } from '../index.ts';
import { routeTo, tabVisible } from '../router/actions.ts';
import { sessionCheck } from '../session/actions.ts';
import { streamOpened, streamReconnecting } from '../stream/actions.ts';
import { sendMessage } from '../threads/actions.ts';
import { setComposerDraft } from '../ui/actions.ts';
import { attachFiles, removeAttachment } from '../attachments/actions.ts';
import { pick } from '../../lib/upload/pick.ts';
import { draftChangedRemotely, draftKeepMine, draftLoad, draftSave, draftUseTheirs } from './actions.ts';
import { selectDraftConflict, selectDraftDirty, selectDraftSync } from './selectors.ts';
import { ME, snapshot, thread } from '../fixtures.ts';

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

const stored = (fileId: string, name = `${fileId}.png`): StoredFileMeta => ({ fileId, name, contentType: 'image/png', sizeBytes: 3, width: null, height: null });

function view(threadId: string, text: string, revision: number, files: StoredFileMeta[] = []): DraftView {
  return { threadId, text, files, revision, updatedAt: new Date(0) };
}

type Server = {
  draft: DraftView | null;
  saves: { text: string; fileIds: string[]; baseRevision: number; keepalive: boolean }[];
  reads: number;
  fail: boolean;
  // A request held at the server until released: the order two requests
  // land in is the test's to choose.
  holdSend: Promise<void> | null;
  holdSave: Promise<void> | null;
};

// A server with one draft of thread t1 and the optimistic lock of the real
// one: a save over the current revision lands, any other base is refused
// with the current draft.
function fakeServer(initial: DraftView | null): { server: Server; api: Api } {
  const server: Server = { draft: initial, saves: [], reads: 0, fail: false, holdSend: null, holdSave: null };
  const api = {
    me: async () => ME,
    snapshot: async () => snapshot({ threads: [thread({ id: 't1' })] }),
    // Every upload of the composer lands as the stored file f9.
    files: { upload: async () => ({ file: stored('f9', 'a.png') }) },
    threads: {
      get: async () => ({ thread: thread({ id: 't1' }) }),
      events: async () => ({ events: [], nextCursor: null }),
      list: async () => ({ threads: [], nextCursor: null }),
      sendMessage: async () => {
        await server.holdSend;
        server.draft = server.draft ? { ...server.draft, text: '', files: [], revision: server.draft.revision + 1 } : null;

        return {};
      },
      draft: async () => {
        server.reads++;

        return { draft: server.draft };
      },
      saveDraft: async (id: string, content: { text: string; fileIds: string[] }, baseRevision: number, options?: { keepalive?: boolean }) => {
        server.saves.push({ ...content, baseRevision, keepalive: options?.keepalive ?? false });
        await server.holdSave;

        if (server.fail) {
          throw new TypeError('Failed to fetch');
        }

        const current = server.draft?.revision ?? 0;

        if (baseRevision !== current) {
          throw new ApiError(409, 'draft_conflict', 'The draft was changed elsewhere', undefined, { code: 'draft_conflict', message: '…', draft: server.draft });
        }

        server.draft = view(id, content.text, current + 1, content.fileIds.map(fileId => stored(fileId)));

        return { draft: server.draft };
      },
    },
  } as unknown as Api;

  return { server, api };
}

async function opened(initial: DraftView | null): Promise<{ store: AppStore; server: Server }> {
  const { server, api } = fakeServer(initial);
  const store = createStore({ api, initialRoute: { key: 'thread', id: 't1' } });

  store.dispatch(sessionCheck());
  await settle();
  await settle();

  return { store, server };
}

describe('the draft of a thread in the store', () => {
  it('is read with the thread and fills the composer: the text and the stored files as chips', async () => {
    const { store, server } = await opened(view('t1', 'Dear all,', 4, [stored('f1', 'plan.png')]));

    assert.equal(server.reads, 1);
    assert.equal(store.getState().ui.composerDrafts.t1, 'Dear all,');

    const [chip] = store.getState().attachments.byThread.t1!;

    assert.deepEqual({ ...chip, preview: chip.preview !== null }, { id: 'stored:f1', name: 'plan.png', size: 3, type: 'image/png', image: true, preview: true, state: 'done', loaded: 3, fileId: 'f1', error: null });
    assert.equal(selectDraftSync(store.getState(), 't1').revision, 4);
    assert.equal(selectDraftDirty(store.getState(), 't1'), false);
  });

  it('reads nothing into an empty composer when the server has none, and a typed text is saved over base 0', async () => {
    const { store, server } = await opened(null);

    assert.equal(store.getState().ui.composerDrafts.t1, undefined);
    store.dispatch(setComposerDraft('t1', 'Hi'));
    assert.equal(selectDraftDirty(store.getState(), 't1'), true);

    await store.dispatch(draftSave('t1'));
    assert.deepEqual(server.saves, [{ text: 'Hi', fileIds: [], baseRevision: 0, keepalive: false }]);
    assert.equal(selectDraftDirty(store.getState(), 't1'), false);
    assert.equal(selectDraftSync(store.getState(), 't1').revision, 1);
  });

  it('a save carries the text and the uploaded files over the revision known; typed during the save stays unsaved', async () => {
    const { store, server } = await opened(view('t1', 'Dear all,', 4));

    store.dispatch(setComposerDraft('t1', 'Dear all, see'));

    const [picked] = pick([new File([new Uint8Array(3)], 'a.png', { type: 'image/png' })], { pasted: false, preview: false });

    store.dispatch(attachFiles('t1', [picked!]));
    await settle();
    assert.equal(store.getState().attachments.byThread.t1?.[0]?.fileId, 'f9');

    const saving = store.dispatch(draftSave('t1')) as unknown as Promise<void>;

    store.dispatch(setComposerDraft('t1', 'Dear all, see the plan'));
    await saving;
    assert.deepEqual(server.saves, [{ text: 'Dear all, see', fileIds: ['f9'], baseRevision: 4, keepalive: false }]);
    assert.equal(selectDraftSync(store.getState(), 't1').revision, 5);
    assert.equal(selectDraftDirty(store.getState(), 't1'), true, 'the later text is not saved yet');

    await store.dispatch(draftSave('t1'));
    assert.equal(server.saves[1]?.text, 'Dear all, see the plan');
    assert.equal(selectDraftDirty(store.getState(), 't1'), false);

    // A chip removed before anything else: the content changed, so does the server's.
    store.dispatch(removeAttachment('t1', picked!.id));
    await store.dispatch(draftSave('t1'));
    assert.deepEqual(server.saves[2], { text: 'Dear all, see the plan', fileIds: [], baseRevision: 6, keepalive: false });
  });

  it('the same content on the server under another revision is adopted; an emptied server draft is written over', async () => {
    const { store, server } = await opened(view('t1', 'Dear all,', 4));

    // Another device saved the very same text meanwhile.
    server.draft = view('t1', 'Dear all, see', 5);
    store.dispatch(setComposerDraft('t1', 'Dear all, see'));
    await store.dispatch(draftSave('t1'));
    assert.equal(server.saves.length, 1);
    assert.equal(selectDraftSync(store.getState(), 't1').revision, 5);
    assert.equal(selectDraftDirty(store.getState(), 't1'), false);
    assert.equal(selectDraftConflict(store.getState(), 't1'), null);

    // Cleared elsewhere (sent from the phone): this tab's text is the only one.
    server.draft = view('t1', '', 7);
    store.dispatch(setComposerDraft('t1', 'Dear all, see the plan'));
    await store.dispatch(draftSave('t1'));
    assert.deepEqual(server.saves.slice(1).map(save => save.baseRevision), [5, 7]);
    assert.equal(server.draft?.text, 'Dear all, see the plan');
    assert.equal(selectDraftSync(store.getState(), 't1').revision, 8);
    assert.equal(selectDraftConflict(store.getState(), 't1'), null);
  });

  it('another text on the server is a conflict: the composer keeps its own and asks — use theirs replaces it, keep mine saves it over', async () => {
    const { store, server } = await opened(view('t1', 'Dear all,', 4));

    server.draft = view('t1', 'From the phone', 5, [stored('f2')]);
    store.dispatch(setComposerDraft('t1', 'From the laptop'));
    await store.dispatch(draftSave('t1'));

    const conflict = selectDraftConflict(store.getState(), 't1');

    assert.equal(conflict?.text, 'From the phone');
    assert.equal(store.getState().ui.composerDrafts.t1, 'From the laptop', 'nothing overwritten');
    assert.equal(selectDraftDirty(store.getState(), 't1'), true);

    // No save while the question stands.
    await store.dispatch(draftSave('t1'));
    assert.equal(server.saves.length, 1);

    store.dispatch(draftUseTheirs('t1', conflict!));
    assert.equal(store.getState().ui.composerDrafts.t1, 'From the phone');
    assert.deepEqual(store.getState().attachments.byThread.t1?.map(att => att.fileId), ['f2']);
    assert.equal(selectDraftSync(store.getState(), 't1').revision, 5);
    assert.equal(selectDraftDirty(store.getState(), 't1'), false);
    assert.equal(selectDraftConflict(store.getState(), 't1'), null);

    // The other way round.
    server.draft = view('t1', 'From the tablet', 6);
    store.dispatch(setComposerDraft('t1', 'Mine, again'));
    await store.dispatch(draftSave('t1'));
    assert.equal(selectDraftConflict(store.getState(), 't1')?.text, 'From the tablet');
    store.dispatch(draftKeepMine('t1'));
    assert.equal(store.getState().ui.composerDrafts.t1, 'Mine, again');
    assert.equal(selectDraftConflict(store.getState(), 't1'), null);
    assert.equal(selectDraftDirty(store.getState(), 't1'), true);
    await store.dispatch(draftSave('t1'));
    assert.equal(server.saves.at(-1)?.baseRevision, 6);
    assert.equal(server.draft?.text, 'Mine, again');
    assert.equal(selectDraftDirty(store.getState(), 't1'), false);
  });

  it('the stream’s frame reads the draft again only past the revision known, and applies it only without unsaved edits', async () => {
    const { store, server } = await opened(view('t1', 'Dear all,', 4));

    // This tab's own save coming back: nothing to read.
    store.dispatch(draftChangedRemotely('t1', 4));
    await settle();
    assert.equal(server.reads, 1);

    // A thread this tab never opened: nothing to read either.
    store.dispatch(draftChangedRemotely('t2', 9));
    await settle();
    assert.equal(server.reads, 1);

    server.draft = view('t1', 'Dear all, from the phone', 5);
    store.dispatch(draftChangedRemotely('t1', 5));
    await settle();
    assert.equal(server.reads, 2);
    assert.equal(store.getState().ui.composerDrafts.t1, 'Dear all, from the phone');
    assert.equal(selectDraftSync(store.getState(), 't1').revision, 5);

    // Typed here meanwhile: the answer is not applied, the tab's save will meet the revision.
    store.dispatch(setComposerDraft('t1', 'Dear all, from the laptop'));
    server.draft = view('t1', 'Dear all, from the phone, more', 6);
    store.dispatch(draftChangedRemotely('t1', 6));
    await settle();
    assert.equal(server.reads, 3);
    assert.equal(store.getState().ui.composerDrafts.t1, 'Dear all, from the laptop');
    assert.equal(selectDraftSync(store.getState(), 't1').revision, 5);
  });

  it('the tab coming back and the tail reopening read the draft again; the snapshot’s repeat does not', async () => {
    const { store, server } = await opened(view('t1', 'Dear all,', 4));

    store.dispatch(tabVisible());
    await settle();
    assert.equal(server.reads, 2);

    store.dispatch(streamOpened());
    await settle();
    assert.equal(server.reads, 2, 'the first opening is not a reconnect');

    store.dispatch(streamReconnecting(new Date(0)));
    store.dispatch(streamOpened());
    await settle();
    assert.equal(server.reads, 3);

    store.dispatch(routeTo({ key: 'home' }));
    store.dispatch(routeTo({ key: 'thread', id: 't1' }));
    await settle();
    assert.equal(server.reads, 4);
  });

  it('a sent message leaves the sent text saved by being sent and what was typed meanwhile unsaved; the empty server is adopted', async () => {
    const { store, server } = await opened(view('t1', 'Hello', 4));
    const sending = store.dispatch(sendMessage('t1', 'Hello')) as unknown as Promise<void>;

    store.dispatch(setComposerDraft('t1', 'Next'));
    await sending;
    assert.equal(server.draft?.text, '');
    assert.equal(store.getState().ui.composerDrafts.t1, 'Next');
    assert.equal(selectDraftDirty(store.getState(), 't1'), true);

    await store.dispatch(draftSave('t1'));
    // Over the stale base first (the clear moved the revision unseen), then over the server's.
    assert.deepEqual(server.saves.map(save => save.baseRevision), [4, 5]);
    assert.equal(server.draft?.text, 'Next');
    assert.equal(selectDraftDirty(store.getState(), 't1'), false);

    // Sent whole, nothing typed: nothing left to save.
    await store.dispatch(sendMessage('t1', 'Next'));
    assert.equal(store.getState().ui.composerDrafts.t1, undefined);
    assert.equal(selectDraftDirty(store.getState(), 't1'), false);
  });

  it('a save of the text being sent that lands after the send adopts the cleared draft — the sent text is not written back', async () => {
    const { store, server } = await opened(view('t1', 'Hello', 4));
    let landSend = () => {};
    let landSave = () => {};

    store.dispatch(setComposerDraft('t1', 'Hello!'));
    server.holdSave = new Promise(resolve => (landSave = resolve));
    server.holdSend = new Promise(resolve => (landSend = resolve));

    // The save left first (the typing rested), the send right after it —
    // and the server takes the send first.
    const saving = store.dispatch(draftSave('t1')) as unknown as Promise<void>;
    const sending = store.dispatch(sendMessage('t1', 'Hello!')) as unknown as Promise<void>;

    landSend();
    await sending;
    assert.equal(server.draft?.text, '');
    assert.equal(server.draft?.revision, 5);
    assert.equal(store.getState().ui.composerDrafts.t1, undefined);

    landSave();
    await saving;
    // Refused over the stale base; the empty draft is what the send left — adopted, not written over.
    assert.deepEqual(server.saves.map(save => save.baseRevision), [4]);
    assert.equal(server.draft?.text, '');
    assert.equal(selectDraftSync(store.getState(), 't1').revision, 5);
    assert.equal(selectDraftDirty(store.getState(), 't1'), false);
    assert.equal(selectDraftConflict(store.getState(), 't1'), null);

    // What is typed afterwards is the next draft, saved over the send's revision.
    store.dispatch(setComposerDraft('t1', 'Next'));
    await store.dispatch(draftSave('t1'));
    assert.deepEqual(server.saves.map(save => save.baseRevision), [4, 5]);
    assert.equal(server.draft?.text, 'Next');
  });

  it('nothing is saved while a send is in flight: the send settles the draft; typed meanwhile is saved after it', async () => {
    const { store, server } = await opened(view('t1', 'Hello', 4));
    let landSend = () => {};

    store.dispatch(setComposerDraft('t1', 'Hello!'));
    server.holdSend = new Promise(resolve => (landSend = resolve));

    const sending = store.dispatch(sendMessage('t1', 'Hello!')) as unknown as Promise<void>;

    await store.dispatch(draftSave('t1'));
    assert.equal(server.saves.length, 0, 'no save of the text being sent');

    store.dispatch(setComposerDraft('t1', 'Next'));
    await store.dispatch(draftSave('t1'));
    assert.equal(server.saves.length, 0, 'not even of the text typed meanwhile');

    landSend();
    await sending;
    assert.equal(server.draft?.text, '');
    assert.equal(store.getState().ui.composerDrafts.t1, 'Next');
    assert.equal(selectDraftDirty(store.getState(), 't1'), true);

    await store.dispatch(draftSave('t1'));
    assert.deepEqual(server.saves.map(save => [save.text, save.baseRevision]), [['Next', 4], ['Next', 5]]);
    assert.equal(server.draft?.text, 'Next');
    assert.equal(selectDraftDirty(store.getState(), 't1'), false);
  });

  it('a failed save keeps the content unsaved and remembers the failure; the next save goes again', async () => {
    const { store, server } = await opened(view('t1', 'Hello', 4));

    server.fail = true;
    store.dispatch(setComposerDraft('t1', 'Hello there'));
    await store.dispatch(draftSave('t1'));
    assert.equal(selectDraftDirty(store.getState(), 't1'), true);
    assert.equal(selectDraftSync(store.getState(), 't1').failure?.code, 'network');

    server.fail = false;
    await store.dispatch(draftSave('t1'));
    assert.equal(selectDraftDirty(store.getState(), 't1'), false);
    assert.equal(selectDraftSync(store.getState(), 't1').failure, null);
  });

  it('a read while a save is in flight is not applied', async () => {
    const { store, server } = await opened(view('t1', 'Hello', 4));

    store.dispatch(setComposerDraft('t1', 'Hello there'));

    const saving = store.dispatch(draftSave('t1')) as unknown as Promise<void>;
    const reading = store.dispatch(draftLoad('t1')) as unknown as Promise<void>;

    await Promise.all([saving, reading]);
    assert.equal(store.getState().ui.composerDrafts.t1, 'Hello there');
    assert.equal(server.saves.length, 1);
  });
});
