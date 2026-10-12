import assert from 'node:assert/strict';
import { test } from 'node:test';
import { viewerMeta } from './viewer.logic.ts';

test('the details line: size, natural size, who and when', () => {
  assert.equal(viewerMeta(['2.1 MiB', 'you → manager, 17:04'], { width: 4032, height: 3024 }), '2.1 MiB · 4032 × 3024 · you → manager, 17:04');
  assert.equal(viewerMeta(['2.1 MiB'], null), '2.1 MiB');
  assert.equal(viewerMeta([], { width: 10, height: 20 }), '10 × 20');
});
