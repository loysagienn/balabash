import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AppendInput } from '../core/envelope.ts';
import { validateEnvelope } from '../core/envelope.ts';
import { createJournalWriter, sanitizeToolResult } from './session-journal.ts';

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

describe('createJournalWriter', () => {
  it('writes a thread in order through slow appends, runs producers in their turn, reads the identity once', async () => {
    const appended: AppendInput[] = [];
    const lookups: string[] = [];
    const writer = createJournalWriter({
      append: async input => {
        // The first append of t1 is the slowest: order must still hold.
        await new Promise(resolve => setTimeout(resolve, input.type === 'session.state' ? 15 : 1));
        appended.push(input);
      },
      identityOf: async threadId => {
        lookups.push(threadId);

        return threadId === 'gone' ? null : { userId: 'u1', agentName: 'engineer' };
      },
    });

    const first = writer.write('t1', [
      { type: 'session.state', payload: { state: 'run' } },
      { type: 'session.tool.started', payload: { toolUseId: 'a', name: 'Bash', input: {} } },
    ]);
    const second = writer.write('t1', async () => [{ type: 'session.context', payload: { totalTokens: 1, maxTokens: 2, percentage: 50 } }]);
    const other = writer.write('t2', [{ type: 'session.state', payload: { state: 'run' } }]);
    const dropped = writer.write('gone', [{ type: 'session.state', payload: { state: 'run' } }]);

    await Promise.all([first, second, other, dropped]);

    assert.deepEqual(
      appended.filter(input => input.threadId === 't1').map(input => input.type),
      ['session.state', 'session.tool.started', 'session.context'],
    );
    assert.deepEqual(appended.filter(input => input.threadId === 't2').map(input => input.type), ['session.state']);
    assert.deepEqual(appended.find(input => input.threadId === 't1'), {
      type: 'session.state',
      actor: 'agent',
      agentName: 'engineer',
      userId: 'u1',
      threadId: 't1',
      payload: { state: 'run' },
    });
    assert.deepEqual(lookups, ['t1', 't2', 'gone']);

    // Every entry the writer produces passes the envelope's own validation.
    for (const input of appended) {
      validateEnvelope(input);
    }
  });

  it('a failing append or producer does not break what follows', async () => {
    const appended: string[] = [];
    const writer = createJournalWriter({
      append: async input => {
        if (input.type === 'session.turn') {
          throw new Error('db down');
        }

        appended.push(input.type);
      },
      identityOf: async () => ({ userId: 'u1', agentName: 'engineer' }),
    });

    await writer.write('t1', [
      { type: 'session.turn', payload: {} },
      { type: 'session.state', payload: { state: 'wait' } },
    ]);
    await writer.write('t1', async () => {
      throw new Error('no session');
    });
    await writer.write('t1', [{ type: 'session.state', payload: { state: 'run' } }]);
    await tick();

    assert.deepEqual(appended, ['session.state', 'session.state']);
  });

  it('a miss is looked up again; the identity cache is bounded', async () => {
    const lookups: string[] = [];
    let known = false;
    const writer = createJournalWriter({
      append: async () => {},
      identityOf: async threadId => {
        lookups.push(threadId);

        return known || threadId !== 'late' ? { userId: 'u1', agentName: 'a' } : null;
      },
      identityCacheSize: 2,
    });

    await writer.write('late', [{ type: 'session.state', payload: { state: 'run' } }]);
    known = true;
    await writer.write('late', [{ type: 'session.state', payload: { state: 'run' } }]);
    await writer.write('late', [{ type: 'session.state', payload: { state: 'run' } }]);
    assert.deepEqual(lookups, ['late', 'late']);

    await writer.write('a', [{ type: 'session.state', payload: { state: 'run' } }]);
    await writer.write('b', [{ type: 'session.state', payload: { state: 'run' } }]);
    await writer.write('late', [{ type: 'session.state', payload: { state: 'run' } }]);
    assert.deepEqual(lookups, ['late', 'late', 'a', 'b', 'late']);
  });
});

describe('sanitizeToolResult', () => {
  it('keeps no bytes of a tool result, in either block dialect', () => {
    assert.equal(sanitizeToolResult('plain'), 'plain');
    assert.equal(sanitizeToolResult(undefined), '');
    assert.deepEqual(sanitizeToolResult({ ok: true }), { ok: true });
    assert.deepEqual(
      sanitizeToolResult([
        { type: 'text', text: 'a picture' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' } },
        { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' },
        { type: 'audio', mimeType: 'audio/wav', data: 'UklGRg==' },
        { type: 'resource', resource: { uri: 'file:///a.bin', mimeType: 'application/octet-stream', blob: 'AAAA' } },
        { type: 'resource', resource: { uri: 'file:///a.txt', mimeType: 'text/plain', text: 'hello' } },
        'odd',
      ]),
      [
        { type: 'text', text: 'a picture' },
        { type: 'image', omitted: true, mediaType: 'image/png' },
        { type: 'document', omitted: true, mediaType: 'application/pdf' },
        { type: 'image', omitted: true, mediaType: 'image/png' },
        { type: 'audio', omitted: true, mediaType: 'audio/wav' },
        { type: 'resource', omitted: true, uri: 'file:///a.bin', mediaType: 'application/octet-stream' },
        { type: 'resource', resource: { uri: 'file:///a.txt', mimeType: 'text/plain', text: 'hello' } },
        'odd',
      ],
    );
  });
});
