import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ApiError } from '../../lib/api/index.ts';
import { canEdit, editorText, isDirty, saveFailure, saved, typed } from './editor.logic.ts';

describe('file area — editor rules', () => {
  it('edits Markdown that previews and nothing else', () => {
    assert.equal(canEdit({ path: 'notes/inbox.md', sizeBytes: 100, mediaType: 'text/markdown' }), true);
    assert.equal(canEdit({ path: 'README.markdown', sizeBytes: 100, mediaType: 'text/markdown' }), true);
    assert.equal(canEdit({ path: 'notes/big.md', sizeBytes: 3 * 1024 * 1024, mediaType: 'text/markdown' }), false);
    assert.equal(canEdit({ path: 'notes/data.csv', sizeBytes: 100, mediaType: 'text/csv' }), false);
    assert.equal(canEdit({ path: 'src/index.ts', sizeBytes: 100, mediaType: 'text/typescript' }), false);
  });

  it('shows the draft over the loaded content and is dirty only when they differ', () => {
    assert.equal(editorText(null, undefined), '');
    assert.equal(editorText(null, '# A\n'), '# A\n');
    assert.equal(editorText({ text: '# B\n', etag: 'W/"1"' }, '# A\n'), '# B\n');
    assert.equal(isDirty(null, '# A\n'), false);
    assert.equal(isDirty({ text: '# A\n', etag: 'W/"1"' }, '# A\n'), false);
    assert.equal(isDirty({ text: '# B\n', etag: 'W/"1"' }, '# A\n'), true);
  });

  it('keeps the validator of the first edit through later loads', () => {
    const first = typed(null, '# A!', 'W/"1"');

    assert.deepEqual(first, { text: '# A!', etag: 'W/"1"' });
    assert.deepEqual(typed(first, '# A!!', 'W/"2"'), { text: '# A!!', etag: 'W/"1"' });
    assert.deepEqual(typed(null, '# A!', null), { text: '# A!', etag: null });
  });

  it('drops the draft a save landed and keeps what was typed meanwhile over the saved content', () => {
    assert.equal(saved(null, '# A\n', 'W/"2"'), null);
    assert.equal(saved({ text: '# A\n', etag: 'W/"1"' }, '# A\n', 'W/"2"'), null);
    assert.deepEqual(saved({ text: '# A\n\nmore', etag: 'W/"1"' }, '# A\n', 'W/"2"'), { text: '# A\n\nmore', etag: 'W/"2"' });
  });

  it('reads a 412 as a conflict and anything else as an error with its words', () => {
    assert.deepEqual(saveFailure(new ApiError(412, 'precondition_failed', 'The file changed since it was read')), { kind: 'conflict', message: 'The file changed since it was read' });
    assert.deepEqual(saveFailure(new ApiError(404, 'not_found', 'No such file')), { kind: 'error', message: 'No such file' });
    assert.deepEqual(saveFailure(new TypeError('Failed to fetch')), { kind: 'error', message: 'Failed to fetch' });
  });
});
