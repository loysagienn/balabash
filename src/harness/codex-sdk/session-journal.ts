// The session journal of codex threads: the subset of session.* events a
// Codex session can report (forms: src/core/event-types.ts; writing:
// ../session-journal.ts), mapped from the ThreadEvent stream of the tap.
// Turns give the state (run / wait) and session.turn with the usage; items
// give the actions — a command (name `Shell`, output and exit code), a
// patch (`FileChange`, the paths), a web search, an MCP call to a server
// other than the bridge (the bridge's calls are the tool.call.* events);
// reasoning is session.thinking, the to-do list is session.plan. No context
// measurement (Codex offers none), no sub-agent frames, no init frame. The
// content of an MCP result passes sanitizeToolResult: no bytes in the log.

import type { ThreadEvent, ThreadItem } from '@openai/codex-sdk';
import type { JsonObject, JsonValue } from '../../core/contract.ts';
import type { SessionState } from '../../projections/session.ts';
import { createJournalWriter, sanitizeToolResult } from '../session-journal.ts';
import type { JournalEntry, JournalWriter } from '../session-journal.ts';
import { subscribeCodexSessionEnd, subscribeCodexStream } from './stream-tap.ts';

export const BRIDGE_SERVER = 'balabash';

// The journal's memory of one session, from its first event until the
// harness closes it.
export type CodexTurnMemory = {
  state: SessionState;
  // Items already journaled as started (an item may complete without a
  // start frame of its own).
  started: Set<string>;
};

export function createCodexTurnMemory(): CodexTurnMemory {
  return { state: 'wait', started: new Set() };
}

type ToolView = { name: string; input: JsonObject } | null;

function toolOf(item: ThreadItem): ToolView {
  switch (item.type) {
    case 'command_execution':
      return { name: 'Shell', input: { command: item.command } };
    case 'file_change':
      return { name: 'FileChange', input: { changes: item.changes.map(change => ({ path: change.path, kind: change.kind })) } };
    case 'web_search':
      return { name: 'WebSearch', input: { query: item.query } };
    case 'mcp_tool_call':
      return item.server === BRIDGE_SERVER
        ? null
        : { name: `mcp__${item.server}__${item.tool}`, input: { arguments: (item.arguments ?? null) as JsonValue } };
    default:
      return null;
  }
}

function completionOf(item: ThreadItem): { result: JsonValue; isError: boolean; exitCode?: number } {
  switch (item.type) {
    case 'command_execution':
      return {
        result: item.aggregated_output,
        isError: item.status === 'failed' || (item.exit_code !== undefined && item.exit_code !== 0),
        ...(item.exit_code !== undefined ? { exitCode: item.exit_code } : {}),
      };
    case 'file_change':
      return { result: { status: item.status }, isError: item.status === 'failed' };
    case 'mcp_tool_call':
      return {
        result: item.result
          ? { content: sanitizeToolResult(item.result.content), structuredContent: (item.result.structured_content ?? null) as JsonValue }
          : ((item.error ?? null) as JsonValue),
        isError: item.status === 'failed',
      };
    default:
      return { result: null, isError: false };
  }
}

export function mapCodexEvent(memory: CodexTurnMemory, event: ThreadEvent): JournalEntry[] {
  const entries: JournalEntry[] = [];

  const setState = (state: SessionState): void => {
    if (memory.state !== state) {
      memory.state = state;
      entries.push({ type: 'session.state', payload: { state } });
    }
  };

  switch (event.type) {
    case 'turn.started':
      setState('run');
      break;

    case 'item.started':
    case 'item.updated':
    case 'item.completed': {
      const { item } = event;

      setState('run');

      if (item.type === 'todo_list') {
        entries.push({
          type: 'session.plan',
          payload: { items: item.items.map(todo => ({ content: todo.text, status: todo.completed ? 'completed' : 'pending' })) },
        });
        break;
      }

      if (item.type === 'reasoning') {
        if (event.type === 'item.completed' && item.text.trim()) {
          entries.push({ type: 'session.thinking', payload: { text: item.text } });
        }

        break;
      }

      const tool = toolOf(item);

      if (!tool) {
        break;
      }

      if (!memory.started.has(item.id)) {
        memory.started.add(item.id);
        entries.push({ type: 'session.tool.started', payload: { toolUseId: item.id, name: tool.name, input: tool.input } });
      }

      if (event.type === 'item.completed') {
        memory.started.delete(item.id);
        entries.push({ type: 'session.tool.completed', payload: { toolUseId: item.id, name: tool.name, ...completionOf(item) } });
      }

      break;
    }

    case 'turn.completed':
      entries.push({ type: 'session.turn', payload: { usage: event.usage as unknown as JsonObject, isError: false } });
      setState('wait');
      break;

    case 'turn.failed':
      entries.push({ type: 'session.turn', payload: { isError: true, error: event.error.message } });
      setState('wait');
      break;

    default:
      break;
  }

  return entries;
}

// Subscribes the journal to the Codex tap and to the end of sessions;
// returns the unsubscribe.
export function startCodexSessionJournal(deps: { writer?: JournalWriter } = {}): () => void {
  const writer = deps.writer ?? createJournalWriter();
  const memories = new Map<string, CodexTurnMemory>();

  const unsubscribeStream = subscribeCodexStream((threadId, event) => {
    let memory = memories.get(threadId);

    if (!memory) {
      memory = createCodexTurnMemory();
      memories.set(threadId, memory);
    }

    const entries = mapCodexEvent(memory, event);

    if (entries.length) {
      void writer.write(threadId, entries);
    }
  });
  const unsubscribeEnd = subscribeCodexSessionEnd(threadId => {
    memories.delete(threadId);
  });

  return () => {
    unsubscribeStream();
    unsubscribeEnd();
  };
}
