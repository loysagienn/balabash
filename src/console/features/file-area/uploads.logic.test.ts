import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Clash, UploadRow } from '../../store/uploads/reducer.ts';
import { clashMeta, clashTitle, keptNames, panelWords, rowWords } from './uploads.logic.ts';

const MB = 1024 * 1024;
const row = (over: Partial<UploadRow>): UploadRow => ({ id: 'r', folder: 'renovation/photos', name: 'a.jpg', size: 2 * MB, type: 'image/jpeg', mode: 'create', state: 'wait', loaded: 0, path: null, error: null, ...over });

test('the panel: running — "Uploading k of N" and the failures; finished — "Uploaded k of N to"', () => {
  const rows = [
    row({ id: '1', state: 'done', path: 'renovation/photos/a.jpg' }),
    row({ id: '2', state: 'up', loaded: MB }),
    row({ id: '3', state: 'wait' }),
    row({ id: '4', state: 'err', error: { reason: 'Connection lost', retry: true } }),
    row({ id: '5', state: 'err', error: { reason: 'Larger than 2 GB', retry: false } }),
  ];
  const running = panelWords(rows);

  assert.deepEqual({ ...running, progress: typeof running.progress }, { title: 'Uploading to', count: 'Uploading 2 of 5', failed: '2 failed', finished: false, progress: 'number' });
  assert.equal(running.progress, 50);

  const finished = panelWords([row({ id: '1', state: 'done' }), row({ id: '2', state: 'done' }), row({ id: '3', state: 'err', error: { reason: 'x', retry: true } })]);

  assert.deepEqual(finished, { title: 'Uploaded 2 of 3 to', count: 'Uploaded 2 of 3', failed: '1 failed', finished: true, progress: 100 });
  assert.equal(panelWords([row({ state: 'done' })]).title, 'Uploaded to');
});

test('a row: waiting, the progress, the size, the reason; a kept file shows the name it got', () => {
  assert.deepEqual(rowWords(row({})), { name: 'a.jpg', status: 'waiting', retry: false });
  assert.equal(rowWords(row({ state: 'up', loaded: 1.3 * MB, size: 2.1 * MB })).status, '1.3 of 2.1 MiB');
  assert.deepEqual(rowWords(row({ state: 'done', path: 'renovation/photos/a (2).jpg' })), { name: 'a (2).jpg', status: '2.0 MiB', state: 'done', retry: false });
  assert.deepEqual(rowWords(row({ state: 'err', error: { reason: 'Larger than 2 GB', retry: false } })), { name: 'a.jpg', status: 'Larger than 2 GB', state: 'err', retry: false });
});

test('the clash dialog: the title, here against new, the names Keep both gives', () => {
  const now = new Date(2026, 9, 12, 18, 0);
  const clash = (over: Partial<Clash>): Clash => ({ id: 'c', folder: 'renovation/estimates', name: 'estimate-v3.xlsx', size: 91 * 1024, type: '', existing: { name: 'estimate-v3.xlsx', sizeBytes: 84 * 1024, modifiedAt: new Date(2026, 9, 12, 16, 20).toISOString(), folder: false }, ...over });

  assert.equal(clashMeta(clash({}), now), 'here 84 KiB · today, 16:20 — new 91 KiB');
  assert.equal(clashMeta(clash({ existing: null }), now), 'already in the folder — new 91 KiB');
  assert.equal(clashTitle([clash({})]), 'estimate-v3.xlsx already exists');
  assert.equal(clashTitle([clash({}), clash({ name: 'tile-invoice.pdf' })]), '2 files already exist');
  assert.deepEqual(keptNames([clash({}), clash({ name: 'tile-invoice.pdf' })], { 'renovation/estimates': ['estimate-v3.xlsx', 'estimate-v3 (2).xlsx', 'tile-invoice.pdf'] }), ['estimate-v3 (3).xlsx', 'tile-invoice (2).pdf']);
});
