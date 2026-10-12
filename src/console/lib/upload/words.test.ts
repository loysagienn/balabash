import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pastedName, percentOf, progressWords, uploadError, uploadingWords } from './words.ts';

test('a failure says why and whether a retry can help', () => {
  assert.deepEqual(uploadError({ status: 413, code: 'too_large', message: '' }), { reason: 'Larger than 2 GB', retry: false });
  assert.deepEqual(uploadError({ status: 413, code: 'unknown', message: '' }), { reason: 'Larger than 2 GB', retry: false });
  assert.deepEqual(uploadError({ status: 0, code: 'network', message: '' }), { reason: 'Connection lost', retry: true });
  assert.deepEqual(uploadError({ status: 507, code: 'no_space', message: '' }), { reason: 'Not enough space on the server', retry: true });
  assert.deepEqual(uploadError({ status: 500, code: 'internal_error', message: '' }), { reason: 'Upload failed', retry: true });
});

test('progress reads in the unit of the whole', () => {
  assert.equal(progressWords(1.3 * 1024 * 1024, 2.1 * 1024 * 1024), '1.3 of 2.1 MiB');
  assert.equal(progressWords(512, 84 * 1024), '0.5 of 84 KiB');
  assert.equal(progressWords(700, 900), '700 of 900 B');
  assert.equal(percentOf(50, 200), 25);
  assert.equal(percentOf(0, 0), 100);
});

test('why Send waits, and the name of a pasted image', () => {
  assert.equal(uploadingWords(1), 'Uploading 1 file…');
  assert.equal(uploadingWords(2), 'Uploading 2 files…');
  assert.equal(pastedName('image/png', new Date(2026, 9, 12, 17, 8)), 'pasted-17-08.png');
  assert.equal(pastedName('image/jpeg', new Date(2026, 9, 12, 9, 5)), 'pasted-09-05.jpg');
});
