import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { thread } from '../../store/fixtures.ts';
import { groupByDay } from './groups.ts';

describe('groupByDay', () => {
  it('splits a newest-first list into day groups with labels', () => {
    const now = new Date(2026, 9, 9, 17, 0);
    const threads = [
      thread({ id: 'a', createdSeq: 9n, createdAt: new Date(2026, 9, 9, 16, 0) }),
      thread({ id: 'b', createdSeq: 8n, createdAt: new Date(2026, 9, 9, 0, 10) }),
      thread({ id: 'c', createdSeq: 7n, createdAt: new Date(2026, 9, 8, 23, 50) }),
      thread({ id: 'd', createdSeq: 2n, createdAt: new Date(2026, 9, 1, 12, 0) }),
    ];
    const groups = groupByDay(threads, now);

    assert.deepEqual(
      groups.map(group => [group.label, group.threads.map(t => t.id)]),
      [
        ['Today, October 9', ['a', 'b']],
        ['Yesterday, October 8', ['c']],
        ['October 1', ['d']],
      ],
    );
    assert.deepEqual(groupByDay([], now), []);
  });
});
