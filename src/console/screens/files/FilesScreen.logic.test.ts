import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { filesShell } from './FilesScreen.logic.ts';

describe('files screen — shell', () => {
  it('names the folder, the file on the phone, and the way back', () => {
    assert.deepEqual(filesShell('', null), { title: 'Files', detail: false });
    assert.deepEqual(filesShell('', 'dir'), { title: 'Files', detail: false });
    assert.deepEqual(filesShell('a/b', 'dir'), { title: 'b', crumb: { label: 'Files', route: { key: 'files', path: '' } }, back: { key: 'files', path: 'a' }, detail: false });
    assert.deepEqual(filesShell('a/b', null), filesShell('a/b', 'dir'));
    assert.deepEqual(filesShell('a/b/c.md', 'file'), {
      title: 'b',
      titleNarrow: 'c.md',
      crumb: { label: 'Files', route: { key: 'files', path: '' } },
      back: { key: 'files', path: 'a/b' },
      detail: true,
    });
    assert.deepEqual(filesShell('c.md', 'file'), { title: 'Files', titleNarrow: 'c.md', crumb: undefined, back: { key: 'files', path: '' }, detail: true });
  });
});
