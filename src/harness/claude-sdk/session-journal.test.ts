// The claude-sdk session journal over SDKMessage fixtures: the frames of a
// real session (captured 2026-10-09, trimmed) plus synthetic ones for the
// frames the capture did not produce.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { JournalEntry, JournalInput, JournalWriter } from '../session-journal.ts';
import { emitSdkMessage, emitSdkSessionEnd } from './stream-tap.ts';
import { createTurnMemory, mapSdkMessage, startClaudeSessionJournal } from './session-journal.ts';

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

    // A state frame after the result changes nothing; the next turn opens
    // with the init the CLI re-sends per user message — a run, not a start.
    assert.deepEqual(mapSdkMessage(memory, frame({ type: 'system', subtype: 'session_state_changed', state: 'idle' })), []);
    assert.deepEqual(mapSdkMessage(memory, init), [{ type: 'session.state', payload: { state: 'run' } }]);
    assert.deepEqual(mapSdkMessage(memory, frame({ type: 'user', message: { role: 'user', content: 'next' }, parent_tool_use_id: null })), []);
    assert.deepEqual(types(mapSdkMessage(memory, result)), ['session.turn', 'session.state']);
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

  it('times a thought from the frame that bounds the output before it, per origin', () => {
    const memory = createTurnMemory();
    const thought = (text: string, parent: string | null = null) => assistant([{ type: 'thinking', thinking: text, signature: 's' }], parent);

    mapSdkMessage(memory, init, 1000);
    // Chatter between the bound and the thought does not move the bound.
    assert.deepEqual(mapSdkMessage(memory, frame({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }), 2000), []);
    assert.deepEqual(mapSdkMessage(memory, thought('plan'), 6000), [{ type: 'session.thinking', payload: { text: 'plan', parentToolUseId: null, durationMs: 5000 } }]);

    mapSdkMessage(memory, assistant([{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }]), 6500);
    mapSdkMessage(memory, frame({ type: 'tool_progress', tool_use_id: 't1', tool_name: 'Bash', parent_tool_use_id: null, elapsed_time_seconds: 1 }), 7500);
    mapSdkMessage(memory, toolResult('t1', 'a b'), 9000);
    // Measured from the tool result, not from the previous thought or the progress tick.
    assert.deepEqual(mapSdkMessage(memory, thought('read it'), 12_000), [{ type: 'session.thinking', payload: { text: 'read it', parentToolUseId: null, durationMs: 3000 } }]);
    // Consecutive thoughts: the second is measured from the first.
    assert.deepEqual(mapSdkMessage(memory, thought('deeper'), 20_000), [{ type: 'session.thinking', payload: { text: 'deeper', parentToolUseId: null, durationMs: 8000 } }]);

    // A sub-agent's frames interleave with the parent's: each origin has its own bound.
    mapSdkMessage(memory, assistant([{ type: 'tool_use', id: 'ag', name: 'Agent', input: { prompt: 'go' } }]), 20_500);
    assert.deepEqual(mapSdkMessage(memory, thought('child first', 'ag'), 23_000), [{ type: 'session.thinking', payload: { text: 'child first', parentToolUseId: 'ag' } }]);
    mapSdkMessage(memory, assistant([{ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/a' } }], 'ag'), 23_100);
    mapSdkMessage(memory, toolResult('t2', 'x', false, 'ag'), 24_000);
    assert.deepEqual(mapSdkMessage(memory, thought('child again', 'ag'), 27_000), [{ type: 'session.thinking', payload: { text: 'child again', parentToolUseId: 'ag', durationMs: 3000 } }]);
    assert.deepEqual(mapSdkMessage(memory, thought('meanwhile', null), 28_000), [{ type: 'session.thinking', payload: { text: 'meanwhile', parentToolUseId: null, durationMs: 7500 } }]);

    // The result ends the turn's clocks; the next turn's init starts them again.
    mapSdkMessage(memory, result, 32_000);
    assert.equal(memory.bounds.size, 0);
    mapSdkMessage(memory, init, 40_000);
    assert.deepEqual(mapSdkMessage(memory, thought('next'), 40_800), [{ type: 'session.thinking', payload: { text: 'next', parentToolUseId: null, durationMs: 800 } }]);
  });

  it('a retry is measured from the end of its announced wait, the redacted-thinking frames do not shorten a thought, a frame of several blocks is unmeasured', () => {
    const memory = createTurnMemory();
    const thought = (text: string) => assistant([{ type: 'thinking', thinking: text, signature: 's' }]);
    const retry = (delay: number) => frame({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 3, retry_delay_ms: delay, error_status: 529, error: 'overloaded' });
    const tokens = (estimated: number) => frame({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: estimated, estimated_tokens_delta: estimated });

    mapSdkMessage(memory, init, 1000);
    // The retry's wait is not thinking: 8 s announced, the thought arrives 10 s later — 2 s of thought.
    assert.deepEqual(types(mapSdkMessage(memory, retry(8000), 1000)), ['session.retry']);
    assert.deepEqual(mapSdkMessage(memory, thought('after the wait'), 11_000), [{ type: 'session.thinking', payload: { text: 'after the wait', parentToolUseId: null, durationMs: 2000 } }]);
    // Repeated retries: the last wait's end is the start; a thought arriving within the wait is 0.
    mapSdkMessage(memory, retry(4000), 12_000);
    mapSdkMessage(memory, retry(2000), 17_000);
    assert.deepEqual(mapSdkMessage(memory, thought('third try'), 20_500), [{ type: 'session.thinking', payload: { text: 'third try', parentToolUseId: null, durationMs: 1500 } }]);
    mapSdkMessage(memory, retry(5000), 21_000);
    assert.deepEqual(mapSdkMessage(memory, thought('early'), 23_000), [{ type: 'session.thinking', payload: { text: 'early', parentToolUseId: null, durationMs: 0 } }]);
    // A bound after the retry (a tool result) is the newer start.
    mapSdkMessage(memory, retry(30_000), 24_000);
    mapSdkMessage(memory, assistant([{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }]), 25_000);
    mapSdkMessage(memory, toolResult('t1', 'a'), 26_000);
    assert.deepEqual(mapSdkMessage(memory, thought('answering'), 29_000), [{ type: 'session.thinking', payload: { text: 'answering', parentToolUseId: null, durationMs: 3000 } }]);

    // thinking_tokens frames arrive at the end of the redacted phase (live: 17 ms before the thought) — not a clock;
    // an empty (redacted) thinking frame is part of the stretch, not its end.
    assert.deepEqual(mapSdkMessage(memory, tokens(400), 38_000), []);
    assert.deepEqual(mapSdkMessage(memory, tokens(900), 38_983), []);
    assert.deepEqual(mapSdkMessage(memory, thought('long'), 39_000), [{ type: 'session.thinking', payload: { text: 'long', parentToolUseId: null, durationMs: 10_000 } }]);
    assert.deepEqual(mapSdkMessage(memory, assistant([{ type: 'thinking', thinking: '', signature: 'x' }]), 45_000), []);
    assert.deepEqual(mapSdkMessage(memory, assistant([]), 45_500), []);
    assert.deepEqual(mapSdkMessage(memory, thought('after redacted'), 46_000), [{ type: 'session.thinking', payload: { text: 'after redacted', parentToolUseId: null, durationMs: 7000 } }]);

    // A frame packing several blocks has no end of its own for any of them: thought + text, text + thought, two thoughts.
    assert.deepEqual(mapSdkMessage(memory, assistant([{ type: 'thinking', thinking: 'a', signature: 's' }, { type: 'text', text: 'b' }]), 50_000), [
      { type: 'session.thinking', payload: { text: 'a', parentToolUseId: null } },
    ]);
    assert.deepEqual(mapSdkMessage(memory, assistant([{ type: 'text', text: 'c' }, { type: 'thinking', thinking: 'd', signature: 's' }]), 54_000), [
      { type: 'session.text', payload: { text: 'b', parentToolUseId: null } },
      { type: 'session.thinking', payload: { text: 'd', parentToolUseId: null } },
    ]);
    assert.deepEqual(
      mapSdkMessage(memory, assistant([{ type: 'thinking', thinking: '', signature: 'x' }, { type: 'thinking', thinking: 'one', signature: 'x' }, { type: 'thinking', thinking: 'two', signature: 'x' }]), 58_000),
      [
        { type: 'session.thinking', payload: { text: 'one', parentToolUseId: null } },
        { type: 'session.thinking', payload: { text: 'two', parentToolUseId: null } },
      ],
    );
    // Such a frame still bounds the next thought.
    assert.deepEqual(mapSdkMessage(memory, thought('alone again'), 60_000), [{ type: 'session.thinking', payload: { text: 'alone again', parentToolUseId: null, durationMs: 2000 } }]);
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
});

describe('startClaudeSessionJournal', () => {
  it('writes the frames of a thread in order and measures the context after the result', async () => {
    const writes: Array<{ threadId: string; input: JournalInput }> = [];
    const writer: JournalWriter = {
      write: async (threadId, input) => {
        writes.push({ threadId, input });

        return true;
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

      // The memory of t1 outlives its result: the next init is a turn, not a
      // start. The session's end evicts it — a fresh session starts again.
      emitSdkMessage('t1', init);
      assert.deepEqual(types(writes.at(-1)!.input as JournalEntry[]), ['session.state']);
      emitSdkMessage('t1', assistant([{ type: 'text', text: 'again' }]));
      assert.equal(writes.length, 6);
      emitSdkSessionEnd('t1');
      emitSdkMessage('t1', init);
      assert.deepEqual(types(writes.at(-1)!.input as JournalEntry[]), ['session.state', 'session.started']);
    } finally {
      stop();
    }

    // A session closed before the measurement has nothing to measure.
    const closedWriter: JournalWriter = { write: async (_threadId, input) => writes.push({ threadId: 'c', input }) > 0 };
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
