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
    const agent = event({ type: 'agent.message', threadId: 'main', payload: { content: [{ type: 'image', fileId: 'f' }, { type: 'text', text: 'Started the designer on the token chart.' }] } });
    const tool = event({ type: 'tool.call.started', threadId: 'main', payload: { callId: 'c', functionName: 'spawn_agent', input: {} } });

    assert.deepEqual(lastMessageOf([user, agent, tool]), { text: 'Started the designer on the token chart.', at: agent.createdAt, seq: agent.seq });
    assert.deepEqual(lastMessageOf([user]), { text: 'Start the designer', at: user.createdAt, seq: user.seq });
    assert.equal(lastMessageOf([tool]), null);
    assert.equal(lastMessageOf([]), null);
  });

  it('words a message as plain text, its code and identifiers as they are', () => {
    resetSeq();
    const user = event({ type: 'user.message', threadId: 'main', payload: { text: 'Rename `foo__bar__baz` in **all** files' } });
    const agent = event({ type: 'agent.message', threadId: 'main', payload: { content: [{ type: 'text', text: '## Done\nStatus: `a || b` | see [doc](https://x/a_(b))' }] } });

    assert.equal(lastMessageOf([user])?.text, 'Rename foo__bar__baz in all files');
    assert.equal(lastMessageOf([user, agent])?.text, 'Done');
    assert.equal(lastMessageOf([event({ type: 'agent.message', threadId: 'main', payload: { content: [{ type: 'text', text: 'Status: `a || b` | see [doc](https://x/a_(b))' }] } })])?.text, 'Status: a || b | see doc');
  });

  it('names the attachments of a message without text, in the writer\'s forms', () => {
    resetSeq();
    const user = event({ type: 'user.message', threadId: 'main', payload: { text: 'Old message' } });
    // Telegram: a photo without a caption — text: null, blocks and files.
    const photo = event({
      type: 'user.message',
      threadId: 'main',
      actor: 'user',
      payload: { text: null, blocks: [{ type: 'image', fileId: 'f' }], files: [{ fileId: 'f', contentType: 'image/jpeg', originalFilename: null, sizeBytes: 1 }] },
    });
    const files = event({ type: 'user.message', threadId: 'main', payload: { text: '', files: [{ fileId: 'a', name: 'a.png', mimeType: 'image/png', size: 1, originalFilename: 'a.png' }, { fileId: 'b', originalFilename: 'b.pdf' }] } });
    const picture = event({ type: 'agent.message', threadId: 'main', payload: { content: [{ type: 'image', fileId: 'f' }] } });
    const named = event({ type: 'agent.message', threadId: 'main', payload: { content: [{ type: 'file', fileId: 'g', name: 'voucher.pdf', mimeType: 'application/pdf', size: 2048 }, { type: 'image', fileId: 'h', name: 'shot.png' }] } });
    const link = event({ type: 'agent.message', threadId: 'main', payload: { content: [{ type: 'resource_link', uri: 'https://x/y', name: 'report.pdf' }] } });
    const empty = event({ type: 'agent.message', threadId: 'main', payload: { content: [] } });

    assert.deepEqual(lastMessageOf([user, photo]), { text: 'image', at: photo.createdAt, seq: photo.seq });
    assert.deepEqual(lastMessageOf([user, photo, files]), { text: 'a.png, b.pdf', at: files.createdAt, seq: files.seq });
    assert.deepEqual(lastMessageOf([user, files, picture]), { text: 'image', at: picture.createdAt, seq: picture.seq });
    assert.deepEqual(lastMessageOf([user, named]), { text: 'voucher.pdf, shot.png', at: named.createdAt, seq: named.seq });
    assert.deepEqual(lastMessageOf([user, link]), { text: 'report.pdf', at: link.createdAt, seq: link.seq });
    assert.deepEqual(lastMessageOf([user, empty]), { text: '', at: empty.createdAt, seq: empty.seq });
  });

  it('takes the later by seq of the loaded events and the message the snapshot carried', () => {
    resetSeq(10n);
    const older = event({ type: 'user.message', threadId: 'main', payload: { text: 'Before the snapshot' } });
    const kept = event({ type: 'agent.message', threadId: 'main', payload: { content: [{ type: 'text', text: 'Carried by the snapshot' }] } });
    const tool = event({ type: 'tool.call.started', threadId: 'main', payload: { callId: 'c', functionName: 'spawn_agent', input: {} } });
    const newer = event({ type: 'user.message', threadId: 'main', payload: { text: 'After the snapshot' } });
    const keptMessage = { text: 'Carried by the snapshot', at: kept.createdAt, seq: kept.seq };

    // Nothing loaded yet: the snapshot's message is the row's.
    assert.deepEqual(lastMessageOf([], kept), keptMessage);
    // Older events loaded (the thread's chunk below the snapshot): still the snapshot's.
    assert.deepEqual(lastMessageOf([older], kept), keptMessage);
    // A newer event that is not a message changes nothing.
    assert.deepEqual(lastMessageOf([older, tool], kept), keptMessage);
    // The tail brought a newer message: the tail's.
    assert.deepEqual(lastMessageOf([older, newer], kept), { text: 'After the snapshot', at: newer.createdAt, seq: newer.seq });
    assert.deepEqual(lastMessageOf([newer, tool], kept), { text: 'After the snapshot', at: newer.createdAt, seq: newer.seq });
    // The kept event itself among the loaded events (the overlap of snapshot and tail): the same message once.
    assert.deepEqual(lastMessageOf([older, kept], kept), keptMessage);
    // Only a message counts as kept: another kind of event is nothing.
    assert.equal(lastMessageOf([], tool), null);
    assert.deepEqual(lastMessageOf([older], tool), { text: 'Before the snapshot', at: older.createdAt, seq: older.seq });
  });
});
