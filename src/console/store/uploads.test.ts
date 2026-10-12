// The uploads of the console over the real store with a fake Api: the
// composer's draft attachments (store/attachments) — each uploads at once,
// over 2 GB never asks, a removed chip cuts its request off and a late
// answer changes nothing, a message of files alone takes the stored ones
// and clears them, a refused send keeps the draft and marks what was not
// accepted — and the file area's queue (store/uploads) — two at a time,
// clashes asked first and answered once, a 409 sends a file back to the
// dialog, cancel, retry and the end of the panel.
//
// Run: npm test  (node:test, native type stripping).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Api, TransferOptions } from '../lib/api/index.ts';
import { ApiError } from '../lib/api/index.ts';
import { pick } from '../lib/upload/pick.ts';
import { createStore } from './index.ts';
import { attachFiles, removeAttachment, uploadAttachment } from './attachments/actions.ts';
import { draftFiles } from './attachments/selectors.ts';
import { sendMessage } from './threads/actions.ts';
import { setComposerDraft } from './ui/actions.ts';
import { answerClash, cancelUpload, closeUploads, retryUpload, uploadFiles } from './uploads/actions.ts';

type Pending<T> = { options: TransferOptions & { conflict?: string }; path?: string; name?: string; resolve: (value: T) => void; reject: (error: unknown) => void };

function deferredUploads<T>() {
  const pending: Pending<T>[] = [];
  const start = (options: TransferOptions & { conflict?: string }, extra: { path?: string; name?: string }) =>
    new Promise<T>((resolve, reject) => {
      const entry: Pending<T> = { options, ...extra, resolve, reject };

      pending.push(entry);
      options.signal?.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true });
    });

  return { pending, start };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

function file(name: string, size: number, type = 'application/octet-stream'): File {
  return new File([new Uint8Array(size)], name, { type });
}

function storedFact(fileId: string, name: string) {
  return { file: { fileId, name, contentType: 'image/png', sizeBytes: 3, width: null, height: null } };
}

test('draft attachments: upload at once, over the limit never asks, progress, done; a message of files alone takes the stored ones and clears them', async () => {
  const uploads = deferredUploads<ReturnType<typeof storedFact>>();
  const sent: { text: string; fileIds?: string[] }[] = [];
  const api = {
    files: { upload: (_file: Blob, name: string, options: TransferOptions) => uploads.start(options, { name }) },
    threads: { sendMessage: async (_id: string, text: string, fileIds?: string[]) => sent.push({ text, fileIds }) },
  } as unknown as Api;
  const store = createStore({ api, initialRoute: { key: 'home' } });
  const huge = file('walkthrough.mov', 1);

  Object.defineProperty(huge, 'size', { value: 2 ** 31 });

  const picked = pick([file('wall.png', 3, 'image/png'), huge]);

  store.dispatch(attachFiles('t1', picked));
  await tick();

  let atts = store.getState().attachments.byThread.t1 ?? [];

  assert.deepEqual(atts.map(att => [att.name, att.state, att.error?.reason ?? null]), [
    ['wall.png', 'up', null],
    ['walkthrough.mov', 'err', 'Larger than 2 GB'],
  ]);
  assert.equal(uploads.pending.length, 1);
  assert.deepEqual(draftFiles(atts), { uploading: 1, ready: [] });

  uploads.pending[0]?.options.onProgress?.(2);
  assert.equal(store.getState().attachments.byThread.t1?.[0]?.loaded, 2);

  // A retry of the refused one does not ask either.
  store.dispatch(uploadAttachment('t1', picked[1]?.id as string));
  await tick();
  assert.equal(uploads.pending.length, 1);

  uploads.pending[0]?.resolve(storedFact('f-wall', 'wall.png'));
  await tick();
  atts = store.getState().attachments.byThread.t1 ?? [];
  assert.deepEqual(draftFiles(atts), { uploading: 0, ready: ['f-wall'] });

  await store.dispatch(sendMessage('t1', '', ['f-wall']));
  assert.deepEqual(sent, [{ text: '', fileIds: ['f-wall'] }]);
  // The sent file left the draft; the refused one stays to be removed.
  assert.deepEqual((store.getState().attachments.byThread.t1 ?? []).map(att => att.name), ['walkthrough.mov']);
});

test('a chip removed while uploading cuts its request off; a late answer changes nothing', async () => {
  const uploads = deferredUploads<ReturnType<typeof storedFact>>();
  const api = { files: { upload: (_file: Blob, name: string, options: TransferOptions) => uploads.start(options, { name }) } } as unknown as Api;
  const store = createStore({ api, initialRoute: { key: 'home' } });
  const [picked] = pick([file('scan.jpg', 5, 'image/jpeg')]);

  store.dispatch(attachFiles('t1', [picked!]));
  await tick();
  store.dispatch(removeAttachment('t1', picked!.id));
  await tick();

  assert.equal(uploads.pending[0]?.options.signal?.aborted, true);
  assert.equal(store.getState().attachments.byThread.t1, undefined);

  uploads.pending[0]?.resolve(storedFact('late', 'scan.jpg'));
  await tick();
  assert.equal(store.getState().attachments.byThread.t1, undefined);
});

test('a failed upload says why and retries; a refused send keeps the draft whole and marks the files not accepted', async () => {
  const uploads = deferredUploads<ReturnType<typeof storedFact>>();
  let refusal: ApiError = new ApiError(400, 'file_not_accepted', '1 file was not accepted', ['f-b']);
  const api = {
    files: { upload: (_file: Blob, name: string, options: TransferOptions) => uploads.start(options, { name }) },
    threads: {
      sendMessage: async () => {
        throw refusal;
      },
    },
  } as unknown as Api;
  const store = createStore({ api, initialRoute: { key: 'home' } });
  const picked = pick([file('a.pdf', 3), file('b.pdf', 3)]);

  store.dispatch(attachFiles('t1', picked));
  await tick();
  uploads.pending[0]?.reject(new ApiError(0, 'network', 'Connection lost'));
  uploads.pending[1]?.resolve(storedFact('f-b', 'b.pdf'));
  await tick();

  let atts = store.getState().attachments.byThread.t1 ?? [];

  assert.deepEqual(atts.map(att => [att.state, att.error?.reason ?? null]), [
    ['err', 'Connection lost'],
    ['done', null],
  ]);

  store.dispatch(uploadAttachment('t1', picked[0]!.id));
  await tick();
  assert.equal(uploads.pending.length, 3);
  uploads.pending[2]?.resolve(storedFact('f-a', 'a.pdf'));
  await tick();

  store.dispatch(setComposerDraft('t1', 'Both files'));
  await store.dispatch(sendMessage('t1', 'Both files', ['f-a', 'f-b']));

  atts = store.getState().attachments.byThread.t1 ?? [];
  assert.deepEqual(atts.map(att => [att.name, att.state, att.error?.reason ?? null]), [
    ['a.pdf', 'done', null],
    ['b.pdf', 'err', 'Not accepted'],
  ]);
  assert.deepEqual(store.getState().attachments.refusal.t1, { kind: 'files', message: '1 file was not accepted', count: 1 });
  assert.equal(store.getState().ui.composerDrafts.t1, 'Both files');

  // Removing the refused chip ends the refusal's say.
  store.dispatch(removeAttachment('t1', picked[1]!.id));
  assert.equal(store.getState().attachments.refusal.t1, undefined);

  refusal = new ApiError(409, 'thread_closed', 'The thread is no longer active');
  await store.dispatch(sendMessage('t1', 'Both files', ['f-a']));
  assert.equal(store.getState().attachments.refusal.t1?.kind, 'closed');
  assert.equal((store.getState().attachments.byThread.t1 ?? []).length, 1);
});

test('uploads to the file area: two at a time, clashes asked first and answered once, a 409 back to the dialog, cancel, retry, the end of the panel', async () => {
  const uploads = deferredUploads<{ file: { path: string } }>();
  const api = {
    workspace: { upload: (path: string, _file: Blob, options: TransferOptions & { conflict?: string }) => uploads.start(options, { path }) },
  } as unknown as Api;
  const store = createStore({ api, initialRoute: { key: 'home' } });
  const picked = pick([file('a.jpg', 4), file('b.jpg', 4), file('c.jpg', 4), file('taken.xlsx', 9)]);

  store.dispatch(uploadFiles('renovation/photos', picked, [{ name: 'taken.xlsx', sizeBytes: 8, modifiedAt: null, folder: false }]));
  await tick();

  let state = store.getState().uploads;

  assert.deepEqual(state.rows.map(row => [row.name, row.state]), [
    ['a.jpg', 'up'],
    ['b.jpg', 'up'],
    ['c.jpg', 'wait'],
  ]);
  assert.deepEqual(state.clashes.map(clash => clash.name), ['taken.xlsx']);
  assert.deepEqual(uploads.pending.map(entry => entry.path), ['renovation/photos/a.jpg', 'renovation/photos/b.jpg']);

  // Keep both — the clashing file queues with its answer.
  store.dispatch(answerClash('keep'));
  await tick();
  assert.equal(store.getState().uploads.clashes.length, 0);

  // a lands: the next one starts.
  uploads.pending[0]?.resolve({ file: { path: 'renovation/photos/a.jpg' } });
  await tick();
  assert.deepEqual(uploads.pending.map(entry => [entry.path, entry.options.conflict ?? null]), [
    ['renovation/photos/a.jpg', null],
    ['renovation/photos/b.jpg', null],
    ['renovation/photos/c.jpg', null],
  ]);

  // b: the name appeared meanwhile — back to the dialog.
  uploads.pending[1]?.reject(new ApiError(409, 'exists', 'A file with this name already exists'));
  await tick();
  state = store.getState().uploads;
  assert.deepEqual(state.clashes.map(clash => [clash.name, clash.existing]), [['b.jpg', null]]);
  assert.deepEqual(uploads.pending[3] && [uploads.pending[3].path, uploads.pending[3].options.conflict], ['renovation/photos/taken.xlsx', 'keep']);

  // c is cancelled: its request is cut off, its row goes.
  store.dispatch(cancelUpload(state.rows.find(row => row.name === 'c.jpg')!.id));
  await tick();
  assert.equal(uploads.pending[2]?.options.signal?.aborted, true);

  // taken.xlsx fails, is retried, lands as the name the server gave.
  uploads.pending[3]?.reject(new ApiError(507, 'no_space', 'Not enough space on the server'));
  await tick();
  state = store.getState().uploads;
  assert.deepEqual(state.rows.map(row => [row.name, row.state, row.error?.reason ?? null]), [
    ['a.jpg', 'done', null],
    ['taken.xlsx', 'err', 'Not enough space on the server'],
  ]);

  store.dispatch(retryUpload(state.rows[1]!.id));
  await tick();
  uploads.pending[4]?.resolve({ file: { path: 'renovation/photos/taken (2).xlsx' } });
  await tick();

  store.dispatch(answerClash('skip'));
  await tick();
  state = store.getState().uploads;
  assert.deepEqual(state.rows.map(row => [row.state, row.path]), [
    ['done', 'renovation/photos/a.jpg'],
    ['done', 'renovation/photos/taken (2).xlsx'],
  ]);
  assert.equal(uploads.pending.length, 5);

  store.dispatch(closeUploads());
  assert.deepEqual(store.getState().uploads.rows, []);
});
