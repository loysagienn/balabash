// Tool calls as the feed shows them: the tool.call.started / completed /
// failed triple of one callId folded into a single item with a status and
// a duration, and consecutive actions folded into groups. Pure, node-free.

import type { Event, JsonObject, ToolResult } from '../core/contract.ts';

export type ToolCallStatus = 'run' | 'done' | 'err';

export type ToolCallView = {
  callId: string;
  functionName: string;
  input: JsonObject | null;
  status: ToolCallStatus;
  // The opening event; null when only the outcome was seen (a window that
  // starts mid-call).
  startedSeq: bigint | null;
  startedAt: Date | null;
  // The closing event; null while the call runs.
  endedSeq: bigint | null;
  endedAt: Date | null;
  durationMs: number | null;
  serverName: string | null;
  toolName: string | null;
  result: ToolResult | null;
  error: string | null;
};

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

// Folds the tool.call.* events of a feed (any order, duplicates tolerated)
// into one view per callId, ordered by the first event seen of each call.
export function pairToolCalls(events: Event[]): ToolCallView[] {
  const byCallId = new Map<string, ToolCallView>();

  for (const event of events) {
    if (!event.type.startsWith('tool.call.')) {
      continue;
    }

    const callId = readString(event.payload.callId);

    if (!callId) {
      continue;
    }

    let view = byCallId.get(callId);

    if (!view) {
      view = {
        callId,
        functionName: readString(event.payload.functionName) ?? '',
        input: null,
        status: 'run',
        startedSeq: null,
        startedAt: null,
        endedSeq: null,
        endedAt: null,
        durationMs: null,
        serverName: null,
        toolName: null,
        result: null,
        error: null,
      };
      byCallId.set(callId, view);
    }

    switch (event.type) {
      case 'tool.call.started': {
        const input = event.payload.input;

        view.startedSeq = event.seq;
        view.startedAt = event.createdAt;
        view.input = typeof input === 'object' && input !== null && !Array.isArray(input) ? input : null;
        break;
      }
      case 'tool.call.completed': {
        view.status = 'done';
        view.endedSeq = event.seq;
        view.endedAt = event.createdAt;
        view.serverName = readString(event.payload.serverName);
        view.toolName = readString(event.payload.toolName);
        view.result = (event.payload.result as ToolResult | undefined) ?? null;
        break;
      }
      case 'tool.call.failed': {
        view.status = 'err';
        view.endedSeq = event.seq;
        view.endedAt = event.createdAt;
        view.error = readString(event.payload.error);
        break;
      }
      default:
        break;
    }

    view.durationMs =
      view.startedAt && view.endedAt ? Math.max(0, view.endedAt.getTime() - view.startedAt.getTime()) : null;
  }

  return [...byCallId.values()];
}

export type ActionGroup<T> = { kind: 'group'; items: T[] } | { kind: 'single'; item: T };

// Consecutive actions become one group (the feed's collapsed run of tool
// lines); everything else passes through alone. A lone action stays a
// group of one — the feed renders it as a line, not a block.
export function groupActions<T>(items: T[], isAction: (item: T) => boolean): ActionGroup<T>[] {
  const result: ActionGroup<T>[] = [];
  let run: T[] | null = null;

  for (const item of items) {
    if (isAction(item)) {
      if (!run) {
        run = [];
        result.push({ kind: 'group', items: run });
      }

      run.push(item);
    } else {
      run = null;
      result.push({ kind: 'single', item });
    }
  }

  return result;
}
