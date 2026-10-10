// The words a message records for a stored file (src/core/file-blocks.ts):
// an image block or a file block by the content type, the facts the row
// knows and nothing for the ones it does not; the entry of a
// thread.message's files with every fact present.
//
// Run: npm test

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileContentBlock, isImageType, messageFile } from './file-blocks.ts';

const row = { id: 'f1', contentType: 'image/PNG', sizeBytes: 1200, originalFilename: 'shot.png' };

describe('fileContentBlock', () => {
  it('is an image block for an image content type, whatever its case, a file block otherwise', () => {
    assert.deepEqual(fileContentBlock(row), { type: 'image', fileId: 'f1', name: 'shot.png', mimeType: 'image/PNG', size: 1200 });
    assert.deepEqual(fileContentBlock({ ...row, contentType: 'application/pdf', originalFilename: 'voucher.pdf' }), { type: 'file', fileId: 'f1', name: 'voucher.pdf', mimeType: 'application/pdf', size: 1200 });
    assert.equal(isImageType('Image/jpeg'), true);
    assert.equal(isImageType('text/plain'), false);
    assert.equal(isImageType(null), false);
  });

  it('carries only the facts the row knows — a row without them is the bare reference', () => {
    assert.deepEqual(fileContentBlock({ id: 'f2', contentType: null, sizeBytes: null, originalFilename: null }), { type: 'file', fileId: 'f2' });
    assert.deepEqual(fileContentBlock({ id: 'f3', contentType: 'image/jpeg', sizeBytes: 0, originalFilename: '' }), { type: 'image', fileId: 'f3', mimeType: 'image/jpeg', size: 0 });
  });
});

describe('messageFile', () => {
  it('is the entry of a thread.message\'s files with every fact present, null where the row has none', () => {
    assert.deepEqual(messageFile(row), { fileId: 'f1', contentType: 'image/PNG', originalFilename: 'shot.png', sizeBytes: 1200 });
    assert.deepEqual(messageFile({ id: 'f2', contentType: null, sizeBytes: null, originalFilename: null }), { fileId: 'f2', contentType: null, originalFilename: null, sizeBytes: null });
  });
});
