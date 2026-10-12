import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { UploadRow } from '../../store/uploads/reducer.ts';
import { landedKeys } from './uploads.ts';

const row = (over: Partial<UploadRow>): UploadRow => ({ id: 'r', folder: 'photos', name: 'a.jpg', size: 1, type: '', mode: 'create', state: 'up', loaded: 0, path: null, error: null, ...over });

test('a landed file invalidates its folder and its own path, once', () => {
  const rows = [row({ id: '1', state: 'done', path: 'photos/a (2).jpg' }), row({ id: '2' }), row({ id: '3', state: 'err' })];

  assert.deepEqual(landedKeys(rows, new Set()), { ids: ['1'], keys: [['workspace', 'photos'], ['workspace', 'photos/a (2).jpg']] });
  assert.deepEqual(landedKeys(rows, new Set(['1'])), { ids: [], keys: [] });
});
