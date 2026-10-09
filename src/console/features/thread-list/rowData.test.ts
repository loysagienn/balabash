import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { thread } from '../../store/fixtures.ts';
import { ctxOf, threadRowData, threadTitle } from './rowData.ts';

const at = (h: number, m: number) => new Date(2026, 9, 9, h, m);
const NOW = at(16, 38);

describe('threadRowData', () => {
  it('words an active thread with since, running time, last action and context', () => {
    const row = threadRowData({
      thread: thread({ id: 't1', title: 'Mini-apps', createdAt: at(14, 2) }),
      state: 'run',
      session: { state: 'run', context: { used: 124_000, max: 200_000 } },
      project: 'Balabash',
      kids: 1,
      headless: false,
      last: { lastCode: 'npm run build' },
      now: NOW,
    });

    assert.deepEqual(row, {
      agent: 'engineer',
      title: 'Mini-apps',
      state: 'run',
      project: 'Balabash',
      kids: 1,
      lastCode: 'npm run build',
      time: 'since 14:02',
      sub: 'running 2h 36m',
      ctx: { percentage: 62, usedTokens: 124_000, maxTokens: 200_000 },
    });
  });

  it('words a closed thread with its range, duration and summary', () => {
    const row = threadRowData({
      thread: thread({ id: 't2', title: 'Public URL scheme', status: 'completed', createdAt: at(14, 9), updatedAt: at(14, 31), description: 'slug is globally unique' }),
      state: 'done',
      session: null,
      project: null,
      kids: 0,
      headless: true,
      last: { lastCode: 'ignored for closed threads' },
      now: NOW,
    });

    assert.deepEqual(row, { agent: 'engineer', title: 'Public URL scheme', state: 'done', headless: true, time: '14:09 → 14:31', sub: '22m', desc: 'slug is globally unique' });
  });

  it('pins the main thread with its last message, its children uncounted and no ring', () => {
    const input = {
      thread: thread({ id: 'main', parentId: null, agent: 'coordinator', createdAt: new Date(2026, 7, 6, 22, 44) }),
      state: 'wait' as const,
      session: { state: 'wait' as const, context: { used: 10, max: 100 } },
      project: null,
      kids: 200,
      headless: false,
      last: { lastCode: 'spawn_agent' },
      now: NOW,
      main: true,
    };

    // No message loaded yet: the row is the title and the pin alone.
    assert.deepEqual(threadRowData({ ...input, lastMessage: null }), { agent: 'coordinator', title: 'Main thread', state: 'wait', pinned: true, time: '' });
    assert.deepEqual(threadRowData({ ...input, lastMessage: { text: 'Started the designer on the token chart', at: at(16, 2) } }), {
      agent: 'coordinator',
      title: 'Main thread',
      state: 'wait',
      pinned: true,
      last: 'Started the designer on the token chart',
      time: '16:02',
    });
    // A message without words (neither text nor attachments): its time alone.
    assert.deepEqual(threadRowData({ ...input, lastMessage: { text: '', at: at(16, 2) } }), { agent: 'coordinator', title: 'Main thread', state: 'wait', pinned: true, time: '16:02' });
    assert.equal(threadRowData({ ...input, lastMessage: { text: 'Hi', at: new Date(2026, 9, 7, 9, 5) } }).time, 'Oct 7, 09:05');
  });

  it('falls back to the summary text and the agent name', () => {
    const t = thread({ id: 't3', title: '  ', status: 'failed', summary: { text: 'Summary here' }, createdAt: at(1, 0), updatedAt: at(1, 4) });

    assert.equal(threadTitle(t), 'engineer');
    assert.equal(threadRowData({ thread: t, state: 'err', session: null, project: null, kids: 0, headless: false, last: null, now: NOW }).desc, 'Summary here');
    assert.equal(ctxOf(null), undefined);
    assert.equal(ctxOf({ state: 'wait', context: null }), undefined);
  });
});
