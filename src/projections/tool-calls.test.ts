import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { groupActions } from './tool-calls.ts';

describe('groupActions', () => {
  it('runs consecutive actions together and passes the rest through', () => {
    const grouped = groupActions(['a1', 'a2', 'm', 'a3', 'm2', 'm3'], item => item.startsWith('a'));

    assert.deepEqual(grouped, [
      { kind: 'group', items: ['a1', 'a2'] },
      { kind: 'single', item: 'm' },
      { kind: 'group', items: ['a3'] },
      { kind: 'single', item: 'm2' },
      { kind: 'single', item: 'm3' },
    ]);
  });
});
