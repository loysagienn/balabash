import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { event, resetSeq } from '../../store/fixtures.ts';
import { lastActionOf, lastMessageOf } from './lastAction.ts';

describe('lastActionOf', () => {
  it('takes the newest telling event', () => {
    resetSeq();
    const events = [
      event({ type: 'thread.progress', threadId: 't1', payload: { text: 'Reading the plan' } }),
      event({ type: 'session.tool.started', threadId: 't1', payload: { toolUseId: 'a', name: 'Bash', input: { command: 'npm run build\nnpm test' } } }),
      event({ type: 'session.text', threadId: 't1', payload: { text: 'Now the docs.' } }),
    ];

    assert.deepEqual(lastActionOf(events), { lastCode: 'npm run build' });
    assert.deepEqual(lastActionOf(events.slice(0, 1)), { last: 'Reading the plan' });
    assert.equal(lastActionOf([]), null);
    assert.equal(lastActionOf([event({ type: 'session.text', threadId: 't1', payload: { text: 'x' } })]), null);
  });

  it('names tools by their file, bridge calls by function, subagents by description', () => {
    assert.deepEqual(lastActionOf([event({ type: 'session.tool.started', threadId: 't1', payload: { toolUseId: 'a', name: 'Edit', input: { file_path: '/home/x/journal.md' } } })]), {
      lastCode: 'Edit journal.md',
    });
    assert.deepEqual(lastActionOf([event({ type: 'session.tool.started', threadId: 't1', payload: { toolUseId: 'a', name: 'FileChange', input: { changes: [{ path: 'src/a.ts', kind: 'update' }] } } })]), {
      lastCode: 'Edit a.ts',
    });
    assert.deepEqual(lastActionOf([event({ type: 'session.tool.started', threadId: 't1', payload: { toolUseId: 'a', name: 'WebSearch', input: { query: 'x' } } })]), { lastCode: 'WebSearch' });
    assert.deepEqual(lastActionOf([event({ type: 'tool.call.started', threadId: 't1', payload: { callId: 'c', functionName: 'spawn_agent', input: {} } })]), { lastCode: 'spawn_agent' });
    assert.deepEqual(lastActionOf([event({ type: 'session.task.started', threadId: 't1', payload: { taskId: 'k', description: 'Explore the repo' } })]), { last: 'Explore the repo' });
  });

  it('clips to the first line and 80 characters', () => {
    const long = 'x'.repeat(100);
    const action = lastActionOf([event({ type: 'thread.progress', threadId: 't1', payload: { text: `${long}\nmore` } })]);

    assert.equal(action?.last?.length, 80);
    assert.ok(action?.last?.endsWith('…'));
  });
});

describe('lastMessageOf', () => {
  it('takes the newest message of the user or the agent, by its first line', () => {
    resetSeq();
    const user = event({ type: 'user.message', threadId: 'main', payload: { text: 'Start the designer\nand report back' } });
    const files = event({ type: 'user.message', threadId: 'main', payload: { text: '', files: [{ fileId: 'f', name: 'a.png', mimeType: 'image/png', size: 1 }] } });
    const agent = event({ type: 'agent.message', threadId: 'main', payload: { content: [{ type: 'image', fileId: 'f' }, { type: 'text', text: 'Started the designer on the token chart.' }] } });
    const tool = event({ type: 'tool.call.started', threadId: 'main', payload: { callId: 'c', functionName: 'spawn_agent', input: {} } });

    assert.deepEqual(lastMessageOf([user, agent, tool]), { text: 'Started the designer on the token chart.', at: agent.createdAt });
    assert.deepEqual(lastMessageOf([user, files]), { text: 'Start the designer', at: user.createdAt });
    assert.equal(lastMessageOf([tool]), null);
    assert.equal(lastMessageOf([]), null);
  });
});
