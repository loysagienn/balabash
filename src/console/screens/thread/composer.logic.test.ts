import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DraftAttachment } from '../../store/attachments/reducer.ts';
import { chipWords, conflictWords, refusalWords, waitWords } from './composer.logic.ts';

const att = (over: Partial<DraftAttachment>): DraftAttachment => ({
  id: 'a',
  name: 'wall.jpg',
  size: 2.1 * 1024 * 1024,
  type: 'image/jpeg',
  image: true,
  preview: null,
  state: 'up',
  loaded: 0,
  fileId: null,
  error: null,
  ...over,
});

test('a chip reads its progress, its size, or the reason with or without Retry', () => {
  assert.deepEqual(chipWords(att({ loaded: 1.3 * 1024 * 1024 })), { status: '1.3 of 2.1 MiB', progress: 62, retry: false });
  assert.deepEqual(chipWords(att({ state: 'done', fileId: 'f' })), { status: '2.1 MiB', state: 'done', retry: false });
  assert.deepEqual(chipWords(att({ state: 'err', error: { reason: 'Connection lost', retry: true } })), { status: 'Connection lost', state: 'err', retry: true });
  assert.deepEqual(chipWords(att({ state: 'err', error: { reason: 'Larger than 2 GB', retry: false } })), { status: 'Larger than 2 GB', state: 'err', retry: false });
});

test('Send waits while files upload', () => {
  assert.equal(waitWords(0), '');
  assert.equal(waitWords(1), 'Uploading 1 file…');
});

test('a refused send says why and what to do', () => {
  assert.deepEqual(refusalWords({ kind: 'closed', message: '', count: 0 }, 'completed', { text: true, files: true }), {
    text: 'Not sent — the thread has completed. Your text and files are kept.',
    action: 'copy',
  });
  assert.deepEqual(refusalWords({ kind: 'closed', message: '', count: 0 }, 'cancelled', { text: false, files: true }), {
    text: 'Not sent — the thread was cancelled. Your files are kept.',
    action: null,
  });
  assert.deepEqual(refusalWords({ kind: 'files', message: '', count: 1 }, 'active', { text: true, files: true }), {
    text: 'Not sent — 1 file was not accepted. Remove it and send again.',
    action: null,
  });
  assert.equal(refusalWords({ kind: 'files', message: '', count: 2 }, 'active', { text: true, files: true }).text, 'Not sent — 2 files were not accepted. Remove them and send again.');
  assert.deepEqual(refusalWords({ kind: 'network', message: 'Failed to fetch', count: 0 }, 'active', { text: true, files: false }), { text: 'Not sent — the connection was lost.', action: 'retry' });
  assert.deepEqual(refusalWords({ kind: 'other', message: 'Internal error', count: 0 }, 'active', { text: true, files: false }), { text: 'Not sent — Internal error.', action: 'retry' });
});

test('the strip of a conflict names what the other version holds', () => {
  assert.equal(conflictWords({ text: 'x', files: 1 }), 'This draft was changed on another device. It has text and a file — use that version, or keep yours?');
  assert.equal(conflictWords({ text: 'x', files: 2 }), 'This draft was changed on another device. It has text and 2 files — use that version, or keep yours?');
  assert.equal(conflictWords({ text: '', files: 1 }), 'This draft was changed on another device. It has a file — use that version, or keep yours?');
  assert.equal(conflictWords({ text: 'x', files: 0 }), 'This draft was changed on another device. It has text — use that version, or keep yours?');
  assert.equal(conflictWords({ text: '', files: 0 }), 'This draft was changed on another device. It has an empty draft — use that version, or keep yours?');
});
