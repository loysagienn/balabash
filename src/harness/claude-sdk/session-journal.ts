// The session journal of claude-sdk threads: a subscriber of the stream tap
// that maps the raw SDKMessage frames of a thread's inner session to
// session.* events (forms: src/core/event-types.ts; writing:
// ../session-journal.ts). Observational — the session never learns the
// journal exists. What is journaled and what is not:
//
// - the state: run while a turn is in flight, wait after its result. The CLI
//   publishes session_state_changed frames only under a flag the harness
//   does not set, so the state is derived from the frames themselves (a turn
//   frame → run, result → wait) and a state frame, when one arrives, is
//   taken as authoritative (requires_action → act);
// - native tool uses (Bash, Read, Edit, Agent, …) with their results; the
//   bridge's own tools (mcp__balabash__*) are already the tool.call.* events
//   and are skipped; a result whose tool use the journal never saw is skipped
//   too (nothing to pair it with);
// - thinking blocks, and assistant text followed by more actions in the
//   same turn (the final text of a turn is the runner's agent.message);
// - the turn itself, then the context window measured after it;
// - sub-agent tasks, compaction, API retries, tool-use summaries;
// - never: stream_event deltas, tool_progress ticks, rate limits (not a fact
//   of the thread), hooks and status chatter.
//
// Image bytes in tool results (a Read of a picture) are not journaled: the
// block is kept with `omitted: true` — the log carries no base64.

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { JsonObject, JsonValue } from '../../core/contract.ts';
import type { SessionPlanItem, SessionTaskUsage } from '../../core/event-types.ts';
import type { SessionState } from '../../projections/session.ts';
import { createJournalWriter } from '../session-journal.ts';
import type { JournalEntry, JournalWriter } from '../session-journal.ts';
import { getThreadContextUsage } from './context-usage.ts';
import { subscribeSdkStream } from './stream-tap.ts';

export const BRIDGE_TOOL_PREFIX = 'mcp__balabash__';

type PendingText = { text: string; parentToolUseId: string | null };

// The journal's memory of one session from the start of a turn to its
// result: the state last recorded, the native tool uses awaiting their
// result, the assistant text not yet known to be intermediate.
export type TurnMemory = {
  state: SessionState;
  tools: Map<string, { name: string; parentToolUseId: string | null }>;
  pendingText: PendingText | null;
};

export function createTurnMemory(): TurnMemory {
  return { state: 'wait', tools: new Map(), pendingText: null };
}

const STATE_OF_FRAME: Record<string, SessionState> = { idle: 'wait', running: 'run', requires_action: 'act' };

type Block = { type?: unknown; text?: unknown; thinking?: unknown; id?: unknown; name?: unknown; input?: unknown };
type ResultBlock = { type?: unknown; tool_use_id?: unknown; content?: unknown; is_error?: unknown };

function blocksOf(content: unknown): Block[] {
  return Array.isArray(content) ? (content as Block[]) : [];
}

function asJsonObject(value: unknown): JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonObject) : {};
}

function taskUsage(usage: { total_tokens: number; tool_uses: number; duration_ms: number }): SessionTaskUsage {
  return { totalTokens: usage.total_tokens, toolUses: usage.tool_uses, durationMs: usage.duration_ms };
}

function planItems(input: unknown): SessionPlanItem[] | null {
  const todos = asJsonObject(input).todos;

  if (!Array.isArray(todos)) {
    return null;
  }

  return todos.map(todo => {
    const item = asJsonObject(todo);

    return {
      content: typeof item.content === 'string' ? item.content : '',
      status: typeof item.status === 'string' ? item.status : 'pending',
      ...(typeof item.activeForm === 'string' ? { activeForm: item.activeForm } : {}),
    };
  });
}

// The tool_result content as the model saw it, minus bytes: text stays,
// images and documents keep their type and nothing else.
export function sanitizeToolResult(content: unknown): JsonValue {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return content === undefined ? '' : (content as JsonValue);
  }

  return content.map((block): JsonValue => {
    const { type } = asJsonObject(block);

    if (type === 'text') {
      return { type: 'text', text: typeof asJsonObject(block).text === 'string' ? (asJsonObject(block).text as string) : '' };
    }

    if (type === 'image' || type === 'document') {
      const source = asJsonObject(asJsonObject(block).source);

      return { type, omitted: true, ...(typeof source.media_type === 'string' ? { mediaType: source.media_type } : {}) };
    }

    return block as JsonValue;
  });
}

// Folds one frame into the memory and returns the entries it produces, in
// order. Pure over its arguments; the owner evicts the memory after a result.
export function mapSdkMessage(memory: TurnMemory, message: SDKMessage): JournalEntry[] {
  const entries: JournalEntry[] = [];

  const setState = (state: SessionState): void => {
    if (memory.state !== state) {
      memory.state = state;
      entries.push({ type: 'session.state', payload: { state } });
    }
  };

  const flushText = (): void => {
    if (memory.pendingText) {
      entries.push({ type: 'session.text', payload: { ...memory.pendingText } });
      memory.pendingText = null;
    }
  };

  switch (message.type) {
    case 'system':
      switch (message.subtype) {
        case 'init':
          setState('run');
          entries.push({
            type: 'session.started',
            payload: {
              model: message.model,
              tools: message.tools,
              mcpServers: message.mcp_servers.map(({ name, status }) => ({ name, status })),
              claudeCodeVersion: message.claude_code_version,
              effort: message.effort ?? null,
              cwd: message.cwd,
            },
          });
          break;
        case 'session_state_changed': {
          const state = STATE_OF_FRAME[message.state];

          if (state) {
            setState(state);
          }

          break;
        }
        case 'compact_boundary': {
          const { trigger, pre_tokens: preTokens, post_tokens: postTokens, duration_ms: durationMs } = message.compact_metadata;

          setState('run');
          entries.push({
            type: 'session.compaction',
            payload: {
              trigger,
              preTokens,
              ...(postTokens !== undefined ? { postTokens } : {}),
              ...(durationMs !== undefined ? { durationMs } : {}),
            },
          });
          break;
        }
        case 'api_retry':
          setState('run');
          entries.push({
            type: 'session.retry',
            payload: {
              attempt: message.attempt,
              maxRetries: message.max_retries,
              retryDelayMs: message.retry_delay_ms,
              errorStatus: message.error_status,
              error: message.error,
            },
          });
          break;
        case 'task_started':
          entries.push({
            type: 'session.task.started',
            payload: {
              taskId: message.task_id,
              ...(message.tool_use_id !== undefined ? { toolUseId: message.tool_use_id } : {}),
              description: message.description,
              ...(message.subagent_type !== undefined ? { subagentType: message.subagent_type } : {}),
              ...(message.is_backgrounded !== undefined ? { backgrounded: message.is_backgrounded } : {}),
            },
          });
          break;
        case 'task_progress':
          entries.push({
            type: 'session.task.progress',
            payload: {
              taskId: message.task_id,
              ...(message.tool_use_id !== undefined ? { toolUseId: message.tool_use_id } : {}),
              description: message.description,
              usage: taskUsage(message.usage),
              ...(message.last_tool_name !== undefined ? { lastToolName: message.last_tool_name } : {}),
              ...(message.summary !== undefined ? { summary: message.summary } : {}),
            },
          });
          break;
        case 'task_notification':
          entries.push({
            type: 'session.task.completed',
            payload: {
              taskId: message.task_id,
              ...(message.tool_use_id !== undefined ? { toolUseId: message.tool_use_id } : {}),
              status: message.status,
              summary: message.summary,
              ...(message.usage ? { usage: taskUsage(message.usage) } : {}),
            },
          });
          break;
        default:
          break;
      }
      break;

    case 'assistant': {
      const parentToolUseId = message.parent_tool_use_id;

      setState('run');

      for (const block of blocksOf(message.message?.content)) {
        if (block.type === 'thinking') {
          if (typeof block.thinking === 'string' && block.thinking.trim()) {
            entries.push({ type: 'session.thinking', payload: { text: block.thinking, parentToolUseId } });
          }
        } else if (block.type === 'text') {
          if (typeof block.text === 'string' && block.text.trim()) {
            flushText();

            // A sub-agent's text is never the turn's final text.
            if (parentToolUseId) {
              entries.push({ type: 'session.text', payload: { text: block.text, parentToolUseId } });
            } else {
              memory.pendingText = { text: block.text, parentToolUseId };
            }
          }
        } else if (block.type === 'tool_use') {
          flushText();

          const name = typeof block.name === 'string' ? block.name : '';
          const toolUseId = typeof block.id === 'string' ? block.id : '';

          if (!name || !toolUseId || name.startsWith(BRIDGE_TOOL_PREFIX)) {
            continue;
          }

          const input = asJsonObject(block.input);

          memory.tools.set(toolUseId, { name, parentToolUseId });
          entries.push({ type: 'session.tool.started', payload: { toolUseId, name, input, parentToolUseId } });

          if (name === 'TodoWrite') {
            const items = planItems(input);

            if (items) {
              entries.push({ type: 'session.plan', payload: { items } });
            }
          }
        }
      }

      break;
    }

    case 'user': {
      setState('run');
      flushText();

      for (const block of blocksOf(message.message?.content) as ResultBlock[]) {
        if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') {
          continue;
        }

        const use = memory.tools.get(block.tool_use_id);

        if (!use) {
          continue;
        }

        memory.tools.delete(block.tool_use_id);
        entries.push({
          type: 'session.tool.completed',
          payload: {
            toolUseId: block.tool_use_id,
            name: use.name,
            result: sanitizeToolResult(block.content),
            isError: block.is_error === true,
            parentToolUseId: use.parentToolUseId,
          },
        });
      }

      break;
    }

    case 'tool_use_summary':
      setState('run');
      entries.push({
        type: 'session.tool.summary',
        payload: { summary: message.summary, precedingToolUseIds: message.preceding_tool_use_ids },
      });
      break;

    case 'result':
      // The last text of the turn is the result itself — the runner delivers
      // it as agent.message.
      memory.pendingText = null;
      memory.tools.clear();
      entries.push({
        type: 'session.turn',
        payload: {
          durationMs: message.duration_ms,
          durationApiMs: message.duration_api_ms,
          numTurns: message.num_turns,
          totalCostUsd: message.total_cost_usd,
          usage: message.usage as unknown as JsonObject,
          stopReason: message.stop_reason ?? null,
          isError: message.is_error,
          subtype: message.subtype,
        },
      });
      setState('wait');
      break;

    case 'stream_event':
      setState('run');
      break;

    default:
      break;
  }

  return entries;
}

export type ClaudeSessionJournalDeps = {
  writer?: JournalWriter;
  contextUsage?: typeof getThreadContextUsage;
};

// Subscribes the journal to the stream tap; returns the unsubscribe.
export function startClaudeSessionJournal(deps: ClaudeSessionJournalDeps = {}): () => void {
  const writer = deps.writer ?? createJournalWriter();
  const contextUsage = deps.contextUsage ?? getThreadContextUsage;
  const memories = new Map<string, TurnMemory>();

  // The context window after the turn, measured once the turn's frames are
  // written. A session closed right after its result has nothing to measure.
  const measureContext = async (threadId: string): Promise<JournalEntry[]> => {
    try {
      const { totalTokens, maxTokens, percentage } = await contextUsage(threadId, { detail: 'summary' });

      return [{ type: 'session.context', payload: { totalTokens, maxTokens, percentage } }];
    } catch {
      return [];
    }
  };

  return subscribeSdkStream((threadId, message) => {
    let memory = memories.get(threadId);

    if (!memory) {
      memory = createTurnMemory();
      memories.set(threadId, memory);
    }

    const entries = mapSdkMessage(memory, message);

    if (entries.length) {
      void writer.write(threadId, entries);
    }

    if (message.type === 'result') {
      memories.delete(threadId);
      void writer.write(threadId, () => measureContext(threadId));
    }
  });
}
