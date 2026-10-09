// The feed of a thread as items of three weights (design-system rule 16,
// frontend.md "Лента треда"): messages as blocks, actions as rows grouped
// when consecutive, system lines and error blocks — from the thread's
// events in seq order (authored in it or addressed to it). Pure: the
// store's selector memoises it per thread on the seq list; the components
// only draw the items. Pairs (a tool's start and end, a sub-agent task's
// progress, a child thread's start and terminal, the plan) are folded into
// one item that stays where it first appeared; an end whose start lies
// before the loaded range (the chunk boundary) stands on its own, where
// it is — the result and the error are in the range, and they show.

import type { Event, JsonObject } from '../../../core/contract.ts';
import type { EventOf, EventPayloads, EventType, SessionPlanItem } from '../../../core/event-types.ts';
import { formatTokensK } from '../../ui/Ring/Ring.logic.ts';
import type { IconName } from '../../ui/Icon/Icon.tsx';
import type { StateName } from '../../ui/atoms/state.ts';
import type { XpState } from '../../ui/Xp/Xp.tsx';
import { actionDuration, bridgeAction, bridgeOutput, isPlanTool, nativeAction } from './actions.ts';
import type { ActionDetail, ActionLabel } from './actions.ts';

export type FeedContext = {
  threadId: string;
  // The thread's agent and its parent's (null — the workspace's main thread).
  agent: string;
  parentAgent: string | null;
  // The agent of another thread the store knows (a child of this one), or null.
  agentOf: (threadId: string) => string | null;
  // The operator's name for the system lines ("<name> asked to cancel the
  // thread"); null — "You". The messages keep the "you" party and the
  // Message block names it.
  you: string | null;
};

export type Attachment = { key: string; href: string; name: string; image: boolean; size: number | null };

export type MessageItem = {
  kind: 'message';
  key: string;
  at: Date;
  from: string;
  to: string;
  variant?: 'task' | 'user';
  tag?: string;
  text: string;
  atts: Attachment[];
  fold: boolean;
};

export type QuietItem = { kind: 'quiet'; key: string; at: Date; text: string };

export type ActionItem = {
  kind: 'action';
  key: string;
  at: Date;
  state: XpState;
  label: ActionLabel;
  // Set when the action ended; a running one shows a live timer. untimed —
  // no duration to show (a thought, a batch summary).
  endedAt: Date | null;
  untimed?: true;
  // Words before the duration: "exit 0", "6 calls", "error".
  endNote: string | null;
  add?: number;
  del?: number;
  detail: ActionDetail | null;
  // A nested call under a batch summary.
  depth?: 1;
  // The frames of a native sub-agent (Agent tool) live under its row.
  nested: FeedItem[];
};

export type ActionsItem = { kind: 'actions'; key: string; items: ActionItem[] };

export type PlanItemView = { text: string; state?: 'run' | 'done' };
export type PlanItem = { kind: 'plan'; key: string; items: PlanItemView[]; done: number; total: number };

export type SubtaskItem = {
  kind: 'subtask';
  key: string;
  at: Date;
  taskKind: string;
  description: string;
  state: StateName;
  meta: string[];
  lastTool: string | null;
  summary: string | null;
};

export type ChildItem = {
  kind: 'child';
  key: string;
  threadId: string;
  agent: string;
  title: string;
  // null — the start is not in the loaded range, only the terminal is.
  startedAt: Date | null;
  endedAt: Date | null;
  // The terminal's state; null while the child is active (the store knows its session).
  state: 'done' | 'err' | 'off' | null;
  summary: string | null;
};

export type SysItem = { kind: 'sys'; key: string; at: Date; icon?: IconName; level?: 'normal' | 'urgent'; state?: StateName; text: string };
export type EvItem = { kind: 'ev'; key: string; at: Date; icon: IconName; state?: StateName; text: string };
export type ErrorItem = { kind: 'error'; key: string; at: Date; icon: IconName; title: string; text: string };

export type FeedItem = MessageItem | QuietItem | ActionsItem | PlanItem | SubtaskItem | ChildItem | SysItem | EvItem | ErrorItem;

const FOLD_CHARS = 800;
const FOLD_LINES = 12;

const is = <T extends EventType>(event: Event, type: T): event is Event & EventOf<T> => event.type === type;

export function fileHref(fileId: string): string {
  return `/api/files/${encodeURIComponent(fileId)}`;
}

function shouldFold(text: string): boolean {
  return text.length > FOLD_CHARS || text.split('\n').length > FOLD_LINES;
}

function contentText(content: EventPayloads['agent.message']['content']): string {
  return content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n\n');
}

function contentAtts(content: EventPayloads['agent.message']['content'], key: string): Attachment[] {
  const atts: Attachment[] = [];

  content.forEach((block, i) => {
    if (block.type === 'image' && typeof block.fileId === 'string') {
      atts.push({ key: `${key}:${i}`, href: fileHref(block.fileId), name: 'image', image: true, size: null });
    } else if (block.type === 'file' && typeof block.fileId === 'string') {
      atts.push({ key: `${key}:${i}`, href: fileHref(block.fileId), name: 'file', image: false, size: null });
    } else if (block.type === 'resource_link' && typeof block.uri === 'string') {
      atts.push({ key: `${key}:${i}`, href: block.uri, name: block.name ?? block.uri, image: typeof block.mimeType === 'string' && block.mimeType.startsWith('image/'), size: block.size ?? null });
    }
  });

  return atts;
}

function userAtts(payload: EventPayloads['user.message'], key: string): Attachment[] {
  if (Array.isArray(payload.files) && payload.files.length > 0) {
    return payload.files.map((file, i) => ({
      key: `${key}:${i}`,
      href: fileHref(file.fileId),
      name: file.originalFilename ?? 'file',
      image: typeof file.contentType === 'string' && file.contentType.startsWith('image/'),
      size: file.sizeBytes ?? null,
    }));
  }

  return Array.isArray(payload.blocks) ? contentAtts(payload.blocks, key) : [];
}

function who(event: Event): string {
  return event.actor === 'user' ? 'you' : (event.agentName ?? 'system');
}

function planState(status: string): PlanItemView['state'] {
  return status === 'completed' ? 'done' : status === 'in_progress' ? 'run' : undefined;
}

function planView(items: SessionPlanItem[]): Omit<PlanItem, 'kind' | 'key'> {
  const views = items.map(item => ({ text: item.content, ...(planState(item.status) ? { state: planState(item.status) } : {}) }));

  return { items: views, done: views.filter(item => item.state === 'done').length, total: views.length };
}

function taskMeta(usage: EventPayloads['session.task.progress']['usage'] | undefined): string[] {
  if (!usage) {
    return [];
  }

  return [`${formatTokensK(usage.totalTokens)} tokens`, `${usage.toolUses} ${usage.toolUses === 1 ? 'call' : 'calls'}`, actionDuration(usage.durationMs)];
}

function terminalState(type: string): ChildItem['state'] {
  return type === 'thread.completed' ? 'done' : type === 'thread.failed' ? 'err' : type === 'thread.cancelled' ? 'off' : null;
}

function notificationIcon(level: string): { icon: IconName; level?: SysItem['level'] } {
  return level === 'urgent' ? { icon: 'bell-ring', level: 'urgent' } : level === 'silent' ? { icon: 'bell-off' } : { icon: 'bell', level: 'normal' };
}

// Builds the items; the group under construction collects consecutive
// actions, nested frames go to the row of their parent tool use.
class Builder {
  readonly items: FeedItem[] = [];
  private group: ActionsItem | null = null;
  private readonly tools = new Map<string, ActionItem>();
  // Per native tool row: its toolUseId (for batch summaries) and the input
  // the start recorded (the end re-derives the details with the result).
  private readonly toolIds = new Map<ActionItem, string>();
  private readonly inputs = new Map<ActionItem, JsonObject>();
  private readonly nestedGroups = new Map<string, ActionsItem>();
  private readonly tasks = new Map<string, SubtaskItem>();
  private readonly children = new Map<string, ChildItem>();
  private plan: PlanItem | null = null;
  private readonly ctx: FeedContext;

  constructor(ctx: FeedContext) {
    this.ctx = ctx;
  }

  private push(item: FeedItem): void {
    this.group = null;
    this.items.push(item);
  }

  // Where the next item of a sub-agent goes: the nested feed of its parent
  // tool use, or the top level when the parent is not in the loaded range.
  private nestedOf(parentToolUseId: string | null | undefined): { items: FeedItem[]; group: () => ActionsItem } | null {
    if (!parentToolUseId) {
      return null;
    }

    const parent = this.tools.get(parentToolUseId);

    if (!parent) {
      return null;
    }

    return {
      items: parent.nested,
      group: () => {
        let group = this.nestedGroups.get(parentToolUseId);
        const last = parent.nested[parent.nested.length - 1];

        if (!group || last !== group) {
          group = { kind: 'actions', key: `${parent.key}:g${parent.nested.length}`, items: [] };
          parent.nested.push(group);
          this.nestedGroups.set(parentToolUseId, group);
        }

        return group;
      },
    };
  }

  private action(item: ActionItem, parentToolUseId?: string | null): void {
    const nested = this.nestedOf(parentToolUseId);

    if (nested) {
      nested.group().items.push(item);

      return;
    }

    if (!this.group) {
      this.group = { kind: 'actions', key: `g${item.key}`, items: [] };
      this.items.push(this.group);
    }

    this.group.items.push(item);
  }

  private quiet(item: QuietItem, parentToolUseId?: string | null): void {
    const nested = this.nestedOf(parentToolUseId);

    if (nested) {
      this.nestedGroups.delete(parentToolUseId!);
      nested.items.push(item);

      return;
    }

    this.push(item);
  }

  add(event: Event): void {
    const key = event.seq.toString();
    const at = event.createdAt;
    const own = event.threadId === this.ctx.threadId;

    if (is(event, 'thread.started')) {
      if (own) {
        const text = event.payload.input ?? '';

        this.push({ kind: 'message', key, at, from: who(event), to: this.ctx.agent, variant: 'task', tag: 'task', text, atts: [], fold: shouldFold(text) });
      } else if (event.threadId) {
        const child: ChildItem = {
          kind: 'child',
          key,
          threadId: event.threadId,
          agent: event.payload.agent,
          title: event.payload.title?.trim() || event.payload.agent,
          startedAt: at,
          endedAt: null,
          state: null,
          summary: null,
        };

        this.children.set(event.threadId, child);
        this.push(child);
      }

      return;
    }

    if (is(event, 'thread.completed') || is(event, 'thread.failed') || is(event, 'thread.cancelled')) {
      const child = !own && event.threadId ? this.children.get(event.threadId) : undefined;

      if (child) {
        child.endedAt = at;
        child.state = terminalState(event.type);

        if (is(event, 'thread.completed')) {
          child.summary = event.payload.summary?.text ?? null;
          child.title = event.payload.title?.trim() || child.title;
        } else if (is(event, 'thread.failed')) {
          child.summary = event.payload.error;
        } else {
          child.summary = event.payload.reason || null;
        }

        return;
      }

      if (!own) {
        if (event.threadId) {
          // The child's start is before the loaded range: the terminal alone.
          const agent = event.agentName ?? this.ctx.agentOf(event.threadId) ?? 'agent';
          const orphan: ChildItem = {
            kind: 'child',
            key,
            threadId: event.threadId,
            agent,
            title: (is(event, 'thread.completed') ? event.payload.title?.trim() : undefined) || agent,
            startedAt: null,
            endedAt: at,
            state: terminalState(event.type),
            summary: is(event, 'thread.completed') ? (event.payload.summary?.text ?? null) : is(event, 'thread.failed') ? event.payload.error : event.payload.reason || null,
          };

          this.children.set(event.threadId, orphan);
          this.push(orphan);
        }

        return;
      }

      if (is(event, 'thread.completed')) {
        this.push({ kind: 'sys', key, at, icon: 'check', state: 'done', text: 'Thread completed' });
      } else if (is(event, 'thread.failed')) {
        this.push({ kind: 'error', key, at, icon: 'octagon-x', title: 'Thread crashed', text: event.payload.error });
      } else {
        const by = event.payload.requestedBy === 'user' ? (this.ctx.you ?? 'you') : event.payload.requestedBy;

        this.push({ kind: 'sys', key, at, icon: 'circle-slash', level: 'normal', text: `Thread cancelled${by ? ` by ${by}` : ''}${event.payload.reason ? ` — ${event.payload.reason}` : ''}` });
      }

      return;
    }

    if (is(event, 'thread.cancel')) {
      this.push({ kind: 'sys', key, at, icon: 'circle-slash', text: `${who(event) === 'you' ? (this.ctx.you ?? 'You') : who(event)} asked to cancel the thread${event.payload.reason ? ` — ${event.payload.reason}` : ''}` });

      return;
    }

    if (is(event, 'thread.interrupt')) {
      this.push({ kind: 'sys', key, at, icon: 'pause', level: 'normal', text: 'Turn stopped — the agent halted and is awaiting a message' });

      return;
    }

    if (is(event, 'thread.progress')) {
      this.push({ kind: 'sys', key, at, icon: 'flag', level: 'normal', text: event.payload.text });

      return;
    }

    if (is(event, 'thread.notification')) {
      this.push({ kind: 'sys', key, at, ...notificationIcon(event.payload.level), text: event.payload.text });

      return;
    }

    if (is(event, 'thread.message')) {
      const text = event.payload.text;
      const atts = (event.payload.fileIds ?? []).map((fileId, i) => ({ key: `${key}:${i}`, href: fileHref(fileId), name: 'file', image: false, size: null }));

      if (own) {
        const to = event.targetThreadId ? (this.children.get(event.targetThreadId)?.agent ?? this.ctx.agentOf(event.targetThreadId) ?? this.ctx.parentAgent ?? 'parent') : (this.ctx.parentAgent ?? 'parent');

        this.push({ kind: 'message', key, at, from: this.ctx.agent, to, text, atts, fold: shouldFold(text) });
      } else {
        const from = event.agentName ?? (event.threadId ? (this.children.get(event.threadId)?.agent ?? this.ctx.agentOf(event.threadId)) : null) ?? 'system';
        const fromChild = event.threadId !== null && this.children.has(event.threadId);

        this.push({ kind: 'message', key, at, from, to: this.ctx.agent, ...(fromChild ? {} : { variant: 'task' as const }), text, atts, fold: shouldFold(text) });
      }

      return;
    }

    if (is(event, 'user.message')) {
      const text = event.payload.text ?? '';

      this.push({ kind: 'message', key, at, from: 'you', to: this.ctx.agent, variant: 'user', text, atts: userAtts(event.payload, key), fold: shouldFold(text) });

      return;
    }

    if (is(event, 'agent.message')) {
      const content = Array.isArray(event.payload.content) ? event.payload.content : [];
      const text = contentText(content);

      this.push({ kind: 'message', key, at, from: event.agentName ?? this.ctx.agent, to: 'you', text, atts: contentAtts(content, key), fold: shouldFold(text) });

      return;
    }

    if (is(event, 'session.thinking')) {
      this.action({ kind: 'action', key, at, state: 'done', label: { icon: 'brain', text: 'Thought' }, endedAt: at, untimed: true, endNote: null, detail: { kind: 'md', text: event.payload.text }, nested: [] }, event.payload.parentToolUseId);

      return;
    }

    if (is(event, 'session.text')) {
      this.quiet({ kind: 'quiet', key, at, text: event.payload.text }, event.payload.parentToolUseId);

      return;
    }

    if (is(event, 'session.tool.started')) {
      if (isPlanTool(event.payload.name)) {
        return;
      }

      const { label, detail, add, del } = nativeAction(event.payload.name, event.payload.input ?? {});
      const item: ActionItem = { kind: 'action', key, at, state: 'run', label, endedAt: null, endNote: null, ...(add !== undefined ? { add } : {}), ...(del !== undefined ? { del } : {}), detail, nested: [] };

      this.tools.set(event.payload.toolUseId, item);
      this.toolIds.set(item, event.payload.toolUseId);
      this.inputs.set(item, event.payload.input ?? {});
      this.action(item, event.payload.parentToolUseId);

      return;
    }

    if (is(event, 'session.tool.completed')) {
      const item = this.tools.get(event.payload.toolUseId);
      const { exitCode, isError, result } = event.payload;
      const failed = isError || (typeof exitCode === 'number' && exitCode !== 0);
      const endNote = typeof exitCode === 'number' ? `exit ${exitCode}` : failed ? 'error' : null;

      if (item) {
        item.state = failed ? 'err' : 'done';
        item.endedAt = at;
        item.endNote = endNote;
        item.detail = nativeAction(event.payload.name, this.inputs.get(item) ?? {}, result, failed).detail ?? item.detail;

        return;
      }

      if (isPlanTool(event.payload.name)) {
        return;
      }

      // The start is before the loaded range: a row of the end alone — the
      // name and the result, no input and no duration.
      const { label, detail } = nativeAction(event.payload.name, {}, result, failed);

      this.action({ kind: 'action', key, at, state: failed ? 'err' : 'done', label, endedAt: at, untimed: true, endNote, detail, nested: [] }, event.payload.parentToolUseId);

      return;
    }

    if (is(event, 'session.tool.summary')) {
      const ids = new Set(event.payload.precedingToolUseIds);
      const group = this.group;

      const listed = (item: ActionItem) => ids.has(this.toolIds.get(item) ?? '');

      if (!group || !group.items.some(listed)) {
        return;
      }

      const summary: ActionItem = { kind: 'action', key, at, state: 'done', label: { icon: 'files', text: event.payload.summary }, endedAt: at, untimed: true, endNote: `${ids.size} ${ids.size === 1 ? 'call' : 'calls'}`, detail: null, nested: [] };
      const preceding = group.items.filter(listed);
      const rest = group.items.filter(item => !listed(item));

      for (const item of preceding) {
        item.depth = 1;
      }

      group.items = [...rest, summary, ...preceding];

      return;
    }

    if (is(event, 'session.plan')) {
      const view = planView(event.payload.items);

      if (this.plan) {
        Object.assign(this.plan, view);
      } else {
        this.plan = { kind: 'plan', key, ...view };
        this.push(this.plan);
      }

      return;
    }

    if (is(event, 'session.task.started')) {
      // The harness announces a task for every tool call that carries a
      // description; the row of the tool already shows those. A card is for
      // a sub-agent (its Agent row holds the frames, the card the usage) or
      // a task without a tool row of its own (a backgrounded one).
      const tool = event.payload.toolUseId ? this.tools.get(event.payload.toolUseId) : undefined;

      if (tool && tool.label.tool !== 'Agent' && !event.payload.backgrounded) {
        return;
      }

      const item: SubtaskItem = {
        kind: 'subtask',
        key,
        at,
        taskKind: event.payload.backgrounded ? 'background task' : event.payload.subagentType ? `${event.payload.subagentType} subagent` : 'subagent',
        description: event.payload.description,
        state: 'run',
        meta: [],
        lastTool: null,
        summary: null,
      };

      this.tasks.set(event.payload.taskId, item);
      this.push(item);

      return;
    }

    if (is(event, 'session.task.progress')) {
      const item = this.tasks.get(event.payload.taskId);

      if (item) {
        item.meta = taskMeta(event.payload.usage);
        item.lastTool = event.payload.lastToolName ?? item.lastTool;
        item.summary = event.payload.summary ?? item.summary;
      }

      return;
    }

    if (is(event, 'session.task.completed')) {
      const item = this.tasks.get(event.payload.taskId);
      const state: StateName = event.payload.status === 'completed' ? 'done' : event.payload.status === 'failed' ? 'err' : 'off';

      if (item) {
        item.state = state;
        item.meta = event.payload.usage ? taskMeta(event.payload.usage) : item.meta;
        item.summary = event.payload.summary || item.summary;

        return;
      }

      // The start is before the loaded range. A task bound to a tool use is
      // represented by that tool's row (an end alone when its start is out
      // of range too); a task of its own gets its card from the end.
      if (!event.payload.toolUseId) {
        this.push({ kind: 'subtask', key, at, taskKind: 'task', description: event.payload.summary, state, meta: taskMeta(event.payload.usage), lastTool: null, summary: null });
      }

      return;
    }

    if (is(event, 'session.compaction')) {
      const { preTokens, postTokens } = event.payload;

      this.push({ kind: 'sys', key, at, icon: 'minimize-2', text: `Context compacted: ${formatTokensK(preTokens)}${typeof postTokens === 'number' ? ` → ${formatTokensK(postTokens)}` : ''} tokens` });

      return;
    }

    if (is(event, 'session.retry')) {
      const { attempt, maxRetries, retryDelayMs, errorStatus } = event.payload;

      this.push({ kind: 'ev', key, at, icon: 'rotate-ccw', state: 'act', text: `API error${errorStatus !== null ? ` ${errorStatus}` : ''} · retry ${attempt} of ${maxRetries} in ${Math.round(retryDelayMs / 1000)}s` });

      return;
    }

    if (is(event, 'session.turn')) {
      if (event.payload.isError && event.payload.error) {
        this.push({ kind: 'error', key, at, icon: 'circle-alert', title: 'The turn ended with an error', text: event.payload.error });
      }

      return;
    }

    if (is(event, 'tool.call.started')) {
      const { label, input } = bridgeAction(event.payload.functionName, event.payload.input ?? {});
      const item: ActionItem = { kind: 'action', key, at, state: 'run', label, endedAt: null, endNote: null, detail: { kind: 'io', input, output: null }, nested: [] };

      this.tools.set(`call:${event.payload.callId}`, item);
      this.action(item);

      return;
    }

    if (is(event, 'tool.call.completed') || is(event, 'tool.call.failed')) {
      const item = this.tools.get(`call:${event.payload.callId}`);
      const failed = is(event, 'tool.call.failed');
      const output = failed ? event.payload.error : bridgeOutput(event.payload.result);
      const isError = failed || event.payload.result?.isError === true;

      if (item) {
        item.state = isError ? 'err' : 'done';
        item.endedAt = at;
        item.endNote = isError ? 'error' : null;
        item.detail = { kind: 'io', input: item.detail?.kind === 'io' ? item.detail.input : '', output };
      } else {
        this.action({
          kind: 'action',
          key,
          at,
          state: isError ? 'err' : 'done',
          label: bridgeAction(event.payload.functionName, {}).label,
          endedAt: at,
          endNote: isError ? 'error' : null,
          detail: { kind: 'io', input: '', output },
          nested: [],
        });
      }

      return;
    }

    if (is(event, 'schedule.fired')) {
      const { name, note, count } = event.payload;

      this.push({ kind: 'sys', key, at, icon: 'clock', text: `Task “${name}” fired${note ? ` · ${note}` : typeof count === 'number' ? ` · ${count} new` : ''}` });

      return;
    }

    if (is(event, 'connection.completed')) {
      this.push({ kind: 'sys', key, at, icon: 'plug', text: `${event.payload.name} · ${event.payload.identity ?? event.payload.account} connected` });

      return;
    }

    if (is(event, 'connection.failed')) {
      this.push({ kind: 'sys', key, at, icon: 'plug', state: 'err', text: `${event.payload.name}: connection failed — ${event.payload.error}` });

      return;
    }

    if (is(event, 'connection.reauthorization_required')) {
      this.push({ kind: 'sys', key, at, icon: 'key-round', state: 'act', text: `${event.payload.name}: sign-in required` });

      return;
    }

    if (is(event, 'oauth_client.provisioned') || is(event, 'secrets.provisioned')) {
      this.push({ kind: 'sys', key, at, icon: 'key-round', text: `${event.payload.server}: ${event.type === 'secrets.provisioned' ? 'secrets' : 'OAuth client'} provisioned` });

      return;
    }

    if (is(event, 'system.exception')) {
      this.push({ kind: 'error', key, at, icon: 'triangle-alert', title: 'System exception', text: event.payload.error });

      return;
    }

    if (is(event, 'system.restart.requested')) {
      this.push({ kind: 'sys', key, at, icon: 'refresh-cw', text: `Restart requested${event.payload.requestedBy ? ` by ${event.payload.requestedBy}` : ''} — ${event.payload.reason}` });

      return;
    }

    if (is(event, 'system.restart.completed')) {
      const failed = event.payload.migrationsFailed?.length ? ` · migrations failed: ${event.payload.migrationsFailed.join(', ')}` : '';

      this.push({ kind: 'sys', key, at, icon: 'refresh-cw', state: failed ? 'err' : 'done', text: `Restarted — ${event.payload.reason}${failed}` });

      return;
    }

    // session.started, session.state, session.context and anything unknown
    // are not drawn — the rail and the header read them from the store.
  }

}

// events — the thread's events in seq order (store/feed selectors).
export function projectFeed(events: readonly Event[], ctx: FeedContext): FeedItem[] {
  const builder = new Builder(ctx);

  for (const event of events) {
    builder.add(event);
  }

  return builder.items;
}
