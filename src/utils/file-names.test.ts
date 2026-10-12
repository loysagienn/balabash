import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UPLOAD_MAX_BYTES, freeNumberedName, numberedName } from './file-names.ts';

test('numberedName puts the number before the last extension', () => {
  assert.equal(numberedName('report.pdf', 1), 'report.pdf');
  assert.equal(numberedName('report.pdf', 2), 'report (2).pdf');
  assert.equal(numberedName('a/b/archive.tar.gz', 3), 'a/b/archive.tar (3).gz');
  assert.equal(numberedName('README', 2), 'README (2)');
  assert.equal(numberedName('.env', 2), '.env (2)');
  assert.equal(numberedName('dir.v2/notes', 2), 'dir.v2/notes (2)');
});

test('freeNumberedName skips the taken names', () => {
  assert.equal(freeNumberedName('x.jpg', new Set(['x.jpg'])), 'x (2).jpg');
  assert.equal(freeNumberedName('x.jpg', new Set(['x.jpg', 'x (2).jpg', 'x (3).jpg'])), 'x (4).jpg');
});

test('the upload limit is the ceiling of a 32-bit size', () => {
  assert.equal(UPLOAD_MAX_BYTES, 2147483647);
});
