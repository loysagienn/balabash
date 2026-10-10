import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fragmentIds } from './fragment.ts';

test('fragmentIds: the decoded fragment first, then the one written', () => {
  assert.deepEqual(fragmentIds('#anchors'), ['anchors']);
  assert.deepEqual(fragmentIds('anchors'), ['anchors']);
  assert.deepEqual(fragmentIds('#%D0%BA%D0%B8'), ['ки', '%D0%BA%D0%B8']);
  assert.deepEqual(fragmentIds('#a%20b'), ['a b', 'a%20b']);
});

test('fragmentIds: nothing to name', () => {
  assert.deepEqual(fragmentIds(''), []);
  assert.deepEqual(fragmentIds('#'), []);
});

test('fragmentIds: a fragment that does not decode is tried as written', () => {
  assert.deepEqual(fragmentIds('#%E0%A4%A'), ['%E0%A4%A']);
  assert.deepEqual(fragmentIds('#100%'), ['100%']);
});
