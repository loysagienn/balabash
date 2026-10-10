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
    // An MCP call outside the bridge is a tool; its result carries no bytes.
    const mcp = {
      id: 'm2',
      type: 'mcp_tool_call',
      server: 'images',
      tool: 'render',
      arguments: { w: 1 },
      status: 'completed',
      result: { content: [{ type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' }], structured_content: { ok: true } },
    };

    assert.deepEqual(mapCodexEvent(memory, ev({ type: 'item.completed', item: mcp })), [
      { type: 'session.tool.started', payload: { toolUseId: 'm2', name: 'mcp__images__render', input: { arguments: { w: 1 } } } },
      {
        type: 'session.tool.completed',
        payload: { toolUseId: 'm2', name: 'mcp__images__render', result: { content: [{ type: 'image', omitted: true, mediaType: 'image/png' }], structuredContent: { ok: true } }, isError: false },
      },
    ]);
    assert.deepEqual(mapCodexEvent(memory, ev({ type: 'item.completed', item: { id: 'a1', type: 'agent_message', text: 'hello' } })), []);
    assert.deepEqual(mapCodexEvent(memory, ev({ type: 'item.started', item: { id: 'r1', type: 'reasoning', text: '' } }), 10_000), []);
    assert.deepEqual(mapCodexEvent(memory, ev({ type: 'item.completed', item: { id: 'r1', type: 'reasoning', text: 'Thinking it over' } }), 13_200), [
      { type: 'session.thinking', payload: { text: 'Thinking it over', durationMs: 3200 } },
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

  it('times a thought without a start frame from the turn start or the previous completed item; nothing before a turn', () => {
    const memory = createCodexTurnMemory();
    const reasoning = (id: string, text: string) => ({ id, type: 'reasoning', text });

    // Between turns there is no bound to measure from.
    assert.deepEqual(mapCodexEvent(memory, ev({ type: 'item.completed', item: reasoning('r0', 'stray') }), 500), [
      { type: 'session.state', payload: { state: 'run' } },
      { type: 'session.thinking', payload: { text: 'stray' } },
    ]);

    mapCodexEvent(memory, ev({ type: 'turn.started' }), 1000);
    assert.deepEqual(mapCodexEvent(memory, ev({ type: 'item.completed', item: reasoning('r1', 'first') }), 5000), [
      { type: 'session.thinking', payload: { text: 'first', durationMs: 4000 } },
    ]);

    const command = { id: 'c1', type: 'command_execution', command: 'ls', aggregated_output: '', status: 'in_progress' };

    mapCodexEvent(memory, ev({ type: 'item.started', item: command }), 5100);
    mapCodexEvent(memory, ev({ type: 'item.completed', item: { ...command, aggregated_output: 'a', exit_code: 0, status: 'completed' } }), 9000);
    // Measured from the command's end, not from the previous thought.
    assert.deepEqual(mapCodexEvent(memory, ev({ type: 'item.completed', item: reasoning('r2', 'second') }), 11_500), [
      { type: 'session.thinking', payload: { text: 'second', durationMs: 2500 } },
    ]);
    // A start frame wins over the bound; an empty thought is nothing but moves the bound.
    mapCodexEvent(memory, ev({ type: 'item.started', item: reasoning('r3', '') }), 12_000);
    assert.deepEqual(mapCodexEvent(memory, ev({ type: 'item.completed', item: reasoning('r3', '  ') }), 12_400), []);
    assert.deepEqual(mapCodexEvent(memory, ev({ type: 'item.completed', item: reasoning('r4', 'third') }), 13_000), [
      { type: 'session.thinking', payload: { text: 'third', durationMs: 600 } },
    ]);

    // Items the journal does not write still bound the output: a long bridge call, a message, a plan.
    mapCodexEvent(memory, ev({ type: 'item.started', item: { id: 'm1', type: 'mcp_tool_call', server: 'balabash', tool: 'get_event', arguments: { seq: 1 }, status: 'in_progress' } }), 13_100);
    assert.deepEqual(
      mapCodexEvent(memory, ev({ type: 'item.completed', item: { id: 'm1', type: 'mcp_tool_call', server: 'balabash', tool: 'get_event', arguments: { seq: 1 }, status: 'completed' } }), 43_000),
      [],
    );
    assert.deepEqual(mapCodexEvent(memory, ev({ type: 'item.completed', item: reasoning('r5', 'after the bridge') }), 46_000), [
      { type: 'session.thinking', payload: { text: 'after the bridge', durationMs: 3000 } },
    ]);
    assert.deepEqual(mapCodexEvent(memory, ev({ type: 'item.completed', item: { id: 'a1', type: 'agent_message', text: 'Looking.' } }), 50_000), []);
    assert.deepEqual(mapCodexEvent(memory, ev({ type: 'item.completed', item: reasoning('r6', 'after the text') }), 52_500), [
      { type: 'session.thinking', payload: { text: 'after the text', durationMs: 2500 } },
    ]);
    assert.deepEqual(mapCodexEvent(memory, ev({ type: 'item.completed', item: { id: 't1', type: 'todo_list', items: [{ text: 'Fix', completed: false }] } }), 53_000).map(entry => entry.type), ['session.plan']);
    assert.deepEqual(mapCodexEvent(memory, ev({ type: 'item.completed', item: reasoning('r7', 'after the plan') }), 54_000), [
      { type: 'session.thinking', payload: { text: 'after the plan', durationMs: 1000 } },
    ]);
    // A started item is not yet a bound.
    mapCodexEvent(memory, ev({ type: 'item.started', item: { ...command, id: 'c2' } }), 54_100);
    assert.deepEqual(mapCodexEvent(memory, ev({ type: 'item.completed', item: reasoning('r8', 'meanwhile') }), 55_000), [
      { type: 'session.thinking', payload: { text: 'meanwhile', durationMs: 1000 } },
    ]);

    const usage = { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 };

    // The turn's end clears the clocks, an unfinished thought included; the next turn starts them anew — after a failed turn too.
    mapCodexEvent(memory, ev({ type: 'item.started', item: reasoning('r9', '') }), 56_000);
    mapCodexEvent(memory, ev({ type: 'turn.completed', usage }), 60_000);
    assert.equal(memory.bound, null);
    assert.equal(memory.reasoningFrom.size, 0);
    assert.deepEqual(mapCodexEvent(memory, ev({ type: 'item.completed', item: reasoning('r9', 'late') }), 61_000), [
      { type: 'session.state', payload: { state: 'run' } },
      { type: 'session.thinking', payload: { text: 'late' } },
    ]);
    mapCodexEvent(memory, ev({ type: 'turn.failed', error: { message: 'boom' } }), 62_000);
    assert.equal(memory.bound, null);
    mapCodexEvent(memory, ev({ type: 'turn.started' }), 70_000);
    assert.deepEqual(mapCodexEvent(memory, ev({ type: 'item.completed', item: reasoning('r10', 'fresh') }), 72_000), [
      { type: 'session.thinking', payload: { text: 'fresh', durationMs: 2000 } },
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
