// The claude-sdk session journal over SDKMessage fixtures: the frames of a
// real session (captured 2026-10-09, trimmed) plus synthetic ones for the
// frames the capture did not produce.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { JournalEntry, JournalInput, JournalWriter } from '../session-journal.ts';
import { emitSdkMessage } from './stream-tap.ts';
import { createTurnMemory, mapSdkMessage, sanitizeToolResult, startClaudeSessionJournal } from './session-journal.ts';

const SESSION = 'e5437102-a12e-4755-b766-849d949be319';

function frame(message: Record<string, unknown>): SDKMessage {
  return { uuid: 'u', session_id: SESSION, ...message } as unknown as SDKMessage;
}

const init = frame({
  type: 'system',
  subtype: 'init',
  cwd: '/work',
  tools: ['Bash', 'Read', 'mcp__balabash__end_thread'],
  mcp_servers: [{ name: 'balabash', status: 'connected', source: 'sdk' }],
  model: 'claude-opus-5-5',
  permissionMode: 'bypassPermissions',
  claude_code_version: '2.1.289',
  effort: 'high',
});

function assistant(content: unknown[], parent: string | null = null): SDKMessage {
  return frame({ type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5-5', content }, parent_tool_use_id: parent });
}

function toolResult(toolUseId: string, content: unknown, isError = false, parent: string | null = null): SDKMessage {
  return frame({
    type: 'user',
    message: { role: 'user', content: [{ tool_use_id: toolUseId, type: 'tool_result', content, is_error: isError }] },
    parent_tool_use_id: parent,
  });
}

const result = frame({
  type: 'result',
  subtype: 'success',
  duration_ms: 4126,
  duration_api_ms: 4482,
  is_error: false,
  num_turns: 2,
  result: 'done',
  stop_reason: 'end_turn',
  total_cost_usd: 0.326,
  usage: { input_tokens: 4, output_tokens: 175 },
  modelUsage: {},
  permission_denials: [],
});

function types(entries: JournalEntry[]): string[] {
  return entries.map(entry => entry.type);
}

describe('mapSdkMessage', () => {
  it('journals the captured turn: start, a native tool with its result, the turn, the state around it', () => {
    const memory = createTurnMemory();

    const first = mapSdkMessage(memory, init);

    assert.deepEqual(types(first), ['session.state', 'session.started']);
    assert.deepEqual(first[0].payload, { state: 'run' });
    assert.deepEqual(first[1].payload, {
      model: 'claude-opus-5-5',
      tools: ['Bash', 'Read', 'mcp__balabash__end_thread'],
      mcpServers: [{ name: 'balabash', status: 'connected' }],
      claudeCodeVersion: '2.1.289',
      effort: 'high',
      cwd: '/work',
    });

    assert.deepEqual(mapSdkMessage(memory, frame({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } })), []);

    const started = mapSdkMessage(
      memory,
      assistant([{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'echo hi', description: 'Print hi' }, caller: { type: 'direct' } }]),
    );

    assert.deepEqual(started, [
      { type: 'session.tool.started', payload: { toolUseId: 'toolu_1', name: 'Bash', input: { command: 'echo hi', description: 'Print hi' }, parentToolUseId: null } },
    ]);

    const completed = mapSdkMessage(memory, toolResult('toolu_1', 'hi'));

    assert.deepEqual(completed, [
      { type: 'session.tool.completed', payload: { toolUseId: 'toolu_1', name: 'Bash', result: 'hi', isError: false, parentToolUseId: null } },
    ]);

    // An empty (redacted) thinking block is nothing; the final text is held back.
    assert.deepEqual(mapSdkMessage(memory, assistant([{ type: 'thinking', thinking: '', signature: 'x' }])), []);
    assert.deepEqual(mapSdkMessage(memory, assistant([{ type: 'text', text: 'The command printed hi.\n\ndone' }])), []);

    const ended = mapSdkMessage(memory, result);

    assert.deepEqual(types(ended), ['session.turn', 'session.state']);
    assert.deepEqual(ended[0].payload, {
      durationMs: 4126,
      durationApiMs: 4482,
      numTurns: 2,
      totalCostUsd: 0.326,
      usage: { input_tokens: 4, output_tokens: 175 },
      stopReason: 'end_turn',
      isError: false,
      subtype: 'success',
    });
    assert.deepEqual(ended[1].payload, { state: 'wait' });
    assert.equal(memory.pendingText, null);
    assert.equal(memory.tools.size, 0);

    // A state frame after the result changes nothing; the next turn's frame runs again.
    assert.deepEqual(mapSdkMessage(memory, frame({ type: 'system', subtype: 'session_state_changed', state: 'idle' })), []);
    assert.deepEqual(mapSdkMessage(memory, frame({ type: 'user', message: { role: 'user', content: 'next' }, parent_tool_use_id: null })), [
      { type: 'session.state', payload: { state: 'run' } },
    ]);
  });

  it('text followed by an action in the same turn is intermediate; a sub-agent text is journaled at once', () => {
    const memory = createTurnMemory();

    mapSdkMessage(memory, init);
    assert.deepEqual(mapSdkMessage(memory, assistant([{ type: 'text', text: 'Let me look.' }])), []);

    const next = mapSdkMessage(memory, assistant([{ type: 'text', text: 'Reading now.' }, { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/a' } }]));

    assert.deepEqual(types(next), ['session.text', 'session.text', 'session.tool.started']);
    assert.deepEqual(next[0].payload, { text: 'Let me look.', parentToolUseId: null });
    assert.deepEqual(next[1].payload, { text: 'Reading now.', parentToolUseId: null });

    assert.deepEqual(mapSdkMessage(memory, assistant([{ type: 'text', text: 'Still going.' }])), []);
    assert.deepEqual(types(mapSdkMessage(memory, toolResult('t2', 'contents'))), ['session.text', 'session.tool.completed']);

    const child = mapSdkMessage(memory, assistant([{ type: 'thinking', thinking: 'hmm', signature: 's' }, { type: 'text', text: 'child says' }], 't-agent'));

    assert.deepEqual(child, [
      { type: 'session.thinking', payload: { text: 'hmm', parentToolUseId: 't-agent' } },
      { type: 'session.text', payload: { text: 'child says', parentToolUseId: 't-agent' } },
    ]);
  });

  it('skips the bridge tools and results it cannot pair; TodoWrite also gives the plan', () => {
    const memory = createTurnMemory();

    mapSdkMessage(memory, init);

    const bridge = mapSdkMessage(memory, assistant([{ type: 'tool_use', id: 'b1', name: 'mcp__balabash__end_thread', input: { title: 'x' } }]));

    assert.deepEqual(bridge, []);
    assert.deepEqual(mapSdkMessage(memory, toolResult('b1', 'accepted')), []);
    assert.deepEqual(mapSdkMessage(memory, toolResult('never-seen', 'x')), []);

    const todo = mapSdkMessage(
      memory,
      assistant([{ type: 'tool_use', id: 'td', name: 'TodoWrite', input: { todos: [{ content: 'Fix', status: 'in_progress', activeForm: 'Fixing' }, { content: 'Test', status: 'pending' }] } }]),
    );

    assert.deepEqual(types(todo), ['session.tool.started', 'session.plan']);
    assert.deepEqual(todo[1].payload, {
      items: [
        { content: 'Fix', status: 'in_progress', activeForm: 'Fixing' },
        { content: 'Test', status: 'pending' },
      ],
    });
  });

  it('maps state frames, compaction, retries, tasks and summaries', () => {
    const memory = createTurnMemory();

    assert.deepEqual(mapSdkMessage(memory, frame({ type: 'system', subtype: 'session_state_changed', state: 'running' })), [
      { type: 'session.state', payload: { state: 'run' } },
    ]);
    assert.deepEqual(mapSdkMessage(memory, frame({ type: 'system', subtype: 'session_state_changed', state: 'requires_action' })), [
      { type: 'session.state', payload: { state: 'act' } },
    ]);
    assert.deepEqual(mapSdkMessage(memory, frame({ type: 'system', subtype: 'session_state_changed', state: 'running' })), [
      { type: 'session.state', payload: { state: 'run' } },
    ]);

    assert.deepEqual(
      mapSdkMessage(memory, frame({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 182_000, post_tokens: 41_000 } })),
      [{ type: 'session.compaction', payload: { trigger: 'auto', preTokens: 182_000, postTokens: 41_000 } }],
    );
    assert.deepEqual(
      mapSdkMessage(memory, frame({ type: 'system', subtype: 'api_retry', attempt: 2, max_retries: 5, retry_delay_ms: 8000, error_status: 529, error: 'overloaded' })),
      [{ type: 'session.retry', payload: { attempt: 2, maxRetries: 5, retryDelayMs: 8000, errorStatus: 529, error: 'overloaded' } }],
    );

    const usage = { total_tokens: 1200, tool_uses: 3, duration_ms: 9000 };

    assert.deepEqual(
      mapSdkMessage(memory, frame({ type: 'system', subtype: 'task_started', task_id: 'task1', tool_use_id: 'ta', description: 'Explore', subagent_type: 'Explore', is_backgrounded: true })),
      [{ type: 'session.task.started', payload: { taskId: 'task1', toolUseId: 'ta', description: 'Explore', subagentType: 'Explore', backgrounded: true } }],
    );
    assert.deepEqual(
      mapSdkMessage(memory, frame({ type: 'system', subtype: 'task_progress', task_id: 'task1', description: 'Explore', usage, last_tool_name: 'Grep' })),
      [{ type: 'session.task.progress', payload: { taskId: 'task1', description: 'Explore', usage: { totalTokens: 1200, toolUses: 3, durationMs: 9000 }, lastToolName: 'Grep' } }],
    );
    assert.deepEqual(
      mapSdkMessage(memory, frame({ type: 'system', subtype: 'task_notification', task_id: 'task1', status: 'completed', output_file: '/o', summary: 'Found it', usage })),
      [{ type: 'session.task.completed', payload: { taskId: 'task1', status: 'completed', summary: 'Found it', usage: { totalTokens: 1200, toolUses: 3, durationMs: 9000 } } }],
    );
    assert.deepEqual(mapSdkMessage(memory, frame({ type: 'tool_use_summary', summary: 'read 6 files in src/api', preceding_tool_use_ids: ['a', 'b'] })), [
      { type: 'session.tool.summary', payload: { summary: 'read 6 files in src/api', precedingToolUseIds: ['a', 'b'] } },
    ]);

    // Deltas and status chatter are not journaled.
    assert.deepEqual(mapSdkMessage(memory, frame({ type: 'stream_event', event: {} })), []);
    assert.deepEqual(mapSdkMessage(memory, frame({ type: 'system', subtype: 'status', status: 'compacting' })), []);
  });

  it('keeps no bytes of a tool result', () => {
    assert.equal(sanitizeToolResult('plain'), 'plain');
    assert.equal(sanitizeToolResult(undefined), '');
    assert.deepEqual(
      sanitizeToolResult([
        { type: 'text', text: 'a picture' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' } },
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' } },
      ]),
      [
        { type: 'text', text: 'a picture' },
        { type: 'image', omitted: true, mediaType: 'image/png' },
        { type: 'document', omitted: true, mediaType: 'application/pdf' },
      ],
    );
  });
});

describe('startClaudeSessionJournal', () => {
  it('writes the frames of a thread in order and measures the context after the result', async () => {
    const writes: Array<{ threadId: string; input: JournalInput }> = [];
    const writer: JournalWriter = {
      write: async (threadId, input) => {
        writes.push({ threadId, input });
      },
    };
    const measured: string[] = [];
    const stop = startClaudeSessionJournal({
      writer,
      contextUsage: async threadId => {
        measured.push(threadId);

        return { totalTokens: 48_659, maxTokens: 1_000_000, percentage: 5 } as unknown as Awaited<ReturnType<typeof import('./context-usage.ts').getThreadContextUsage>>;
      },
    });

    try {
      emitSdkMessage('t1', init);
      emitSdkMessage('t2', init);
      emitSdkMessage('t1', assistant([{ type: 'tool_use', id: 'x', name: 'Bash', input: { command: 'ls' } }]));
      emitSdkMessage('t1', frame({ type: 'stream_event', event: {} }));
      emitSdkMessage('t1', result);

      assert.deepEqual(
        writes.map(write => `${write.threadId}:${typeof write.input === 'function' ? 'producer' : types(write.input).join(',')}`),
        ['t1:session.state,session.started', 't2:session.state,session.started', 't1:session.tool.started', 't1:session.turn,session.state', 't1:producer'],
      );

      const producer = writes.at(-1)!.input as () => Promise<JournalEntry[]>;

      assert.deepEqual(await producer(), [{ type: 'session.context', payload: { totalTokens: 48_659, maxTokens: 1_000_000, percentage: 5 } }]);
      assert.deepEqual(measured, ['t1']);

      // The memory of t1 ended with its result: the next frame starts a turn.
      emitSdkMessage('t1', assistant([{ type: 'text', text: 'again' }]));
      assert.deepEqual(types(writes.at(-1)!.input as JournalEntry[]), ['session.state']);
    } finally {
      stop();
    }

    // A session closed before the measurement has nothing to measure.
    const closedWriter: JournalWriter = { write: async (_threadId, input) => void writes.push({ threadId: 'c', input }) };
    const stopClosed = startClaudeSessionJournal({
      writer: closedWriter,
      contextUsage: async () => {
        throw new Error('thread c has no live SDK session');
      },
    });

    try {
      emitSdkMessage('c', result);
      assert.deepEqual(await (writes.at(-1)!.input as () => Promise<JournalEntry[]>)(), []);
    } finally {
      stopClosed();
    }
  });
});
