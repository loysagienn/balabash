import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ThreadEvent } from '@openai/codex-sdk';
import { createCodexTurnMemory, mapCodexEvent } from './session-journal.ts';

const ev = (event: Record<string, unknown>): ThreadEvent => event as unknown as ThreadEvent;

describe('mapCodexEvent', () => {
  it('journals a turn: state, commands with their exit code, a patch, the plan, reasoning, the usage', () => {
    const memory = createCodexTurnMemory();

    assert.deepEqual(mapCodexEvent(memory, ev({ type: 'thread.started', thread_id: 'x' })), []);
    assert.deepEqual(mapCodexEvent(memory, ev({ type: 'turn.started' })), [{ type: 'session.state', payload: { state: 'run' } }]);

    const command = { id: 'c1', type: 'command_execution', command: 'npm test', aggregated_output: '', status: 'in_progress' };

    assert.deepEqual(mapCodexEvent(memory, ev({ type: 'item.started', item: command })), [
      { type: 'session.tool.started', payload: { toolUseId: 'c1', name: 'Shell', input: { command: 'npm test' } } },
    ]);
    assert.deepEqual(mapCodexEvent(memory, ev({ type: 'item.updated', item: { ...command, aggregated_output: 'running' } })), []);
    assert.deepEqual(
      mapCodexEvent(memory, ev({ type: 'item.completed', item: { ...command, aggregated_output: 'FAIL', exit_code: 1, status: 'failed' } })),
      [{ type: 'session.tool.completed', payload: { toolUseId: 'c1', name: 'Shell', result: 'FAIL', isError: true, exitCode: 1 } }],
    );

    // A patch that completes without a start frame of its own is started then completed.
    const patch = { id: 'p1', type: 'file_change', changes: [{ path: 'src/a.ts', kind: 'update' }], status: 'completed' };

    assert.deepEqual(mapCodexEvent(memory, ev({ type: 'item.completed', item: patch })), [
      { type: 'session.tool.started', payload: { toolUseId: 'p1', name: 'FileChange', input: { changes: [{ path: 'src/a.ts', kind: 'update' }] } } },
      { type: 'session.tool.completed', payload: { toolUseId: 'p1', name: 'FileChange', result: { status: 'completed' }, isError: false } },
    ]);

    assert.deepEqual(
      mapCodexEvent(memory, ev({ type: 'item.completed', item: { id: 'm1', type: 'mcp_tool_call', server: 'balabash', tool: 'end_thread', arguments: {}, status: 'completed' } })),
      [],
    );
    assert.deepEqual(mapCodexEvent(memory, ev({ type: 'item.completed', item: { id: 'a1', type: 'agent_message', text: 'hello' } })), []);
    assert.deepEqual(mapCodexEvent(memory, ev({ type: 'item.started', item: { id: 'r1', type: 'reasoning', text: '' } })), []);
    assert.deepEqual(mapCodexEvent(memory, ev({ type: 'item.completed', item: { id: 'r1', type: 'reasoning', text: 'Thinking it over' } })), [
      { type: 'session.thinking', payload: { text: 'Thinking it over' } },
    ]);
    assert.deepEqual(
      mapCodexEvent(memory, ev({ type: 'item.updated', item: { id: 't1', type: 'todo_list', items: [{ text: 'Fix', completed: true }, { text: 'Test', completed: false }] } })),
      [{ type: 'session.plan', payload: { items: [{ content: 'Fix', status: 'completed' }, { content: 'Test', status: 'pending' }] } }],
    );

    const usage = { input_tokens: 10, cached_input_tokens: 5, cache_write_input_tokens: 0, output_tokens: 3, reasoning_output_tokens: 1 };

    assert.deepEqual(mapCodexEvent(memory, ev({ type: 'turn.completed', usage })), [
      { type: 'session.turn', payload: { usage, isError: false } },
      { type: 'session.state', payload: { state: 'wait' } },
    ]);
  });

  it('a failed turn is a turn with an error', () => {
    const memory = createCodexTurnMemory();

    mapCodexEvent(memory, ev({ type: 'turn.started' }));
    assert.deepEqual(mapCodexEvent(memory, ev({ type: 'turn.failed', error: { message: 'boom' } })), [
      { type: 'session.turn', payload: { isError: true, error: 'boom' } },
      { type: 'session.state', payload: { state: 'wait' } },
    ]);
  });
});
