// The feed of a thread as items of three weights (design-system rule 16,
// frontend.md "Лента треда"): messages as blocks, actions as rows grouped
// when consecutive, system lines and error blocks — from the thread's
// events in seq order (authored in it or addressed to it). Pure: the
// store's selector memoises it per thread on the seq list; the components
// only draw the items. Pairs (a tool's start and end, a sub-agent task's
// progress, a child thread's start and terminal, the plan) are folded into
// one item that stays where it first appeared; an end whose start lies
// before the loaded range (the chunk boundary) stands on its own, where
// it is — the result and the error are in the range, and they show. A
// native sub-agent's frames are the exception: they live only under its
// Agent row, so while that row is before the loaded range they are not
// drawn (they would read as the thread's own actions and text) — what the
// sub-agent brought back shows where it finished, as its report row.

import type { Event, JsonObject } from '../../../core/contract.ts';
import type { EventOf, EventPayloads, EventType, InboundFile, SessionPlanItem } from '../../../core/event-types.ts';
import { dateTimeLabel } from '../../lib/format/index.ts';
import { formatTokensK } from '../../ui/Ring/Ring.logic.ts';
import type { IconName } from '../../ui/Icon/Icon.tsx';
import type { StateName } from '../../ui/atoms/state.ts';
import type { XpState } from '../../ui/Xp/Xp.tsx';
import { actionDuration, bridgeAction, bridgeOutput, clipLine, isPlanTool, nativeAction } from './actions.ts';
import type { ActionDetail, ActionLabel } from './actions.ts';
import { withWorkspace } from '../../lib/workspace/state.ts';

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

// An attachment of a message: a stored file by id (fileId; name and size as
// the event recorded them — null where the history carries the id alone,
// and the component asks the file's meta: attachments.ts) or a
// resource_link by uri (fileId null).
export type Attachment = { key: string; href: string; fileId: string | null; name: string | null; image: boolean; size: number | null };

// A question of the agent that needs the user's decision (agent.ask): the
// options are its quick replies while it is open; the outcome, once
// resolved (agent.ask.resolved in the loaded range), makes the card static
// — decided from Balabash (`by.identity`: the name and the time) or closed
// in the external system (decidedBy null).
export type AskView = { threadId: string; askId: string; askKind: string; options: string[]; link: string | null; outcome: string | null; decidedBy: string | null; decidedAt: Date | null };

// The kind of a question as the card tags it (design: Message askKind):
// approval · sign-in (a credential, completed only by its link) · question.
export function askKindTag(kind: string): 'approval' | 'sign-in' | 'question' {
  return kind === 'approval' ? 'approval' : kind === 'credential' ? 'sign-in' : 'question';
}

// The line under a resolved question: "Decided: allow · Vladimir, 15:45"
// from Balabash, "Closed in the external system: allow" otherwise; null
// while it is open.
export function askDecidedWords(ask: AskView, now: Date): string | null {
  if (ask.outcome === null) {
    return null;
  }

  return ask.decidedBy !== null ? `Decided: ${ask.outcome} · ${ask.decidedBy}${ask.decidedAt ? `, ${dateTimeLabel(ask.decidedAt, now)}` : ''}` : `Closed in the external system: ${ask.outcome}`;
}

export type MessageItem = {
  kind: 'message';
  key: string;
  at: Date;
  from: string;
  to: string;
  variant?: 'task' | 'user' | 'ask';
  tag?: string;
  text: string;
  atts: Attachment[];
  fold: boolean;
  ask?: AskView;
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
// plain — the text is prose, not an error's output.
export type ErrorItem = { kind: 'error'; key: string; at: Date; icon: IconName; title: string; text: string; plain?: true };

export type FeedItem = MessageItem | QuietItem | ActionsItem | PlanItem | SubtaskItem | ChildItem | SysItem | EvItem | ErrorItem;

const FOLD_CHARS = 800;
const FOLD_LINES = 12;

const is = <T extends EventType>(event: Event, type: T): event is Event & EventOf<T> => event.type === type;

// A stored file's bytes, in the tab's workspace (?ws=: a link, an <img>).
export function fileHref(fileId: string): string {
  return withWorkspace(`/api/files/${encodeURIComponent(fileId)}`);
}

// A long message between agents (a task, a report, a message to a child)
// folds behind "Show more"; the conversation with the user — the user's
// messages and the agent's answers — is always shown whole.
function shouldFold(text: string): boolean {
  return text.length > FOLD_CHARS || text.split('\n').length > FOLD_LINES;
}

function contentText(content: EventPayloads['agent.message']['content']): string {
  return content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n\n');
}

function isImageType(contentType: string | null | undefined): boolean {
  return typeof contentType === 'string' && contentType.toLowerCase().startsWith('image/');
}

// A stored file as an attachment: the facts the event recorded, null for
// the ones it did not.
function storedAtt(key: string, fileId: string, facts: { name?: string | null; image: boolean; size?: number | null }): Attachment {
  return { key, href: fileHref(fileId), fileId, name: facts.name ?? null, image: facts.image, size: facts.size ?? null };
}

// The files of a message in the form of user.message.files (thread.message
// carries the same): image by the content type.
function messageFileAtts(files: readonly InboundFile[], key: string): Attachment[] {
  return files.map((file, i) => storedAtt(`${key}:${i}`, file.fileId, { name: file.originalFilename, image: isImageType(file.contentType), size: file.sizeBytes }));
}

// Files by id alone (a summary's fileIds, a thread.message without files):
// everything about them is the meta's to tell.
export function fileIdAtts(fileIds: readonly string[], key: string): Attachment[] {
  return fileIds.map((fileId, i) => storedAtt(`${key}:${i}`, fileId, { image: false }));
}

function contentAtts(content: EventPayloads['agent.message']['content'], key: string): Attachment[] {
  const atts: Attachment[] = [];

  content.forEach((block, i) => {
    if ((block.type === 'image' || block.type === 'file') && typeof block.fileId === 'string') {
      atts.push(storedAtt(`${key}:${i}`, block.fileId, { name: block.name, image: block.type === 'image', size: block.size }));
    } else if (block.type === 'resource_link' && typeof block.uri === 'string') {
      atts.push({ key: `${key}:${i}`, href: block.uri, fileId: null, name: block.name ?? block.uri, image: isImageType(block.mimeType), size: block.size ?? null });
    }
  });

  return atts;
}

function userAtts(payload: EventPayloads['user.message'], key: string): Attachment[] {
  if (Array.isArray(payload.files) && payload.files.length > 0) {
    return messageFileAtts(payload.files, key);
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

// The words the remote engine writes (src/remote/engine.ts, mirror.ts),
// drawn as the design shows them (Thread Feed §06); the first words are the
// engine's, kept in step with it by hand.
const REMOTE_NOTIFICATION_ICONS: readonly [prefix: string, icon: IconName][] = [
  ['Needs your decision:', 'triangle-alert'],
  ['The session cannot be watched:', 'eye-off'],
  ['The session is watched again.', 'eye'],
  ['The thread was not paused:', 'info'],
  ['The thread is finishing —', 'info'],
];

function notificationIcon(level: string, text: string): { icon: IconName; level?: SysItem['level'] } {
  const own = REMOTE_NOTIFICATION_ICONS.find(([prefix]) => text.startsWith(prefix))?.[1];

  return level === 'urgent' ? { icon: own ?? 'bell-ring', level: 'urgent' } : level === 'silent' ? { icon: own ?? 'bell-off' } : { icon: own ?? 'bell', level: 'normal' };
}

// A remote thread crashed because its session is gone (the engine's one
// failure: src/remote/engine.ts) — the block says so in words.
const REMOTE_GONE = 'the remote session is gone';

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
  // The report rows of sub-agents, by the toolUseId their end names.
  private readonly reports = new Map<string, ActionItem>();
  // The calls of sub-agents not drawn (unplaced), and where each drawn
  // call nests (its parentToolUseId): a task announced for such a call is
  // the sub-agent's own, not the thread's.
  private readonly unplacedCalls = new Set<string>();
  private readonly callParents = new Map<string, string>();
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

  // A frame of a sub-agent whose Agent row is not in the loaded range: not
  // drawn — the row brings it along once the range reaches back to it.
  private unplaced(parentToolUseId: string | null | undefined): boolean {
    return Boolean(parentToolUseId) && !this.tools.has(parentToolUseId!);
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

  // The thread's own terminal is the last word on its session: a row still
  // running at that point never gets its end — the completion was lost on
  // its way to the log, or the thread was cancelled mid-call — so it ends
  // with the thread, without an outcome, instead of a timer ticking on. The
  // journal's tail may land after the terminal (a closed author is legal,
  // server.md): a row that starts there, or a task announced again, is
  // closed the same way, where it starts; a real end that follows still
  // brings its outcome.
  private ended: Date | null = null;

  private endOpen(at: Date): void {
    this.ended = at;

    for (const item of this.tools.values()) {
      if (item.state === 'run') {
        this.off(item, at);
      }
    }

    for (const task of this.tasks.values()) {
      if (task.state === 'run') {
        task.state = 'off';
      }
    }
  }

  private off(item: ActionItem, at: Date): void {
    item.state = 'off';
    item.endedAt = at;
  }

  // A row starting now: running, or — after the terminal — closed where it
  // starts (the terminal's time when the start's clock reads earlier: a
  // transaction's now() is its start, the terminal's is the later word).
  private open(item: ActionItem): ActionItem {
    if (this.ended) {
      this.off(item, item.at.getTime() > this.ended.getTime() ? item.at : this.ended);
    }

    return item;
  }

  private get runState(): SubtaskItem['state'] {
    return this.ended ? 'off' : 'run';
  }

  // A block (not a row) where it belongs: under the Agent row of its
  // sub-agent, or at the top level.
  private place(item: QuietItem | SubtaskItem, parentToolUseId?: string | null): void {
    const nested = this.nestedOf(parentToolUseId);

    if (nested) {
      this.nestedGroups.delete(parentToolUseId!);
      nested.items.push(item);

      return;
    }

    this.push(item);
  }

  // A sub-agent ended (an agent's task: the harness reports its usage, a
  // shell or monitor task has none): what it brought back to the thread —
  // its last text, which the thread's agent received — as one collapsed row
  // where it finished, the whole text on opening. The same text closes the
  // sub-agent's frames under its Agent row; the row here stands whether
  // that row is loaded or not, so it neither moves nor vanishes as the
  // range grows.
  private report(event: Event & EventOf<'session.task.completed'>, key: string, at: Date, state: StateName, task: SubtaskItem | undefined): void {
    const { toolUseId, usage, summary, status } = event.payload;

    // A sub-agent a sub-agent ran reports to that one: under its row, or
    // not at all while that row is out of range.
    if (!usage || (toolUseId && this.unplacedCalls.has(toolUseId))) {
      return;
    }

    // The task's words, else its Agent row's (a continuation through
    // SendMessage names the task its sub-agent first ran as).
    const row = toolUseId ? this.tools.get(toolUseId) : undefined;
    const description = task?.description ?? (row?.label.tool === 'Agent' ? row.label.arg : undefined);
    const item: ActionItem = {
      kind: 'action',
      key,
      at,
      state: state === 'done' ? 'done' : state === 'err' ? 'err' : 'off',
      label: { icon: 'bot', text: 'Subagent report', ...(description ? { textArg: clipLine(description) } : {}) },
      endedAt: at,
      untimed: true,
      endNote: status === 'completed' ? null : status,
      detail: summary.trim() ? { kind: 'report', text: summary } : null,
      nested: [],
    };

    if (toolUseId) {
      this.reports.set(toolUseId, item);
    }

    this.action(item, toolUseId ? this.callParents.get(toolUseId) : undefined);
  }

  add(event: Event): void {
    const key = event.seq.toString();
    const at = event.createdAt;
    const own = event.threadId === this.ctx.threadId;

    if (is(event, 'thread.started')) {
      if (own) {
        const text = event.payload.input ?? '';
        const atts = Array.isArray(event.payload.files) && event.payload.files.length > 0 ? messageFileAtts(event.payload.files, key) : fileIdAtts(event.payload.fileIds ?? [], key);

        this.push({ kind: 'message', key, at, from: who(event), to: this.ctx.agent, variant: 'task', tag: 'task', text, atts, fold: shouldFold(text) });
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

      this.endOpen(at);

      if (is(event, 'thread.completed')) {
        this.push({ kind: 'sys', key, at, icon: 'check', state: 'done', text: 'Thread completed' });
      } else if (is(event, 'thread.failed')) {
        if (event.payload.error === REMOTE_GONE) {
          this.push({ kind: 'error', key, at, icon: 'unplug', title: 'The remote session is gone', text: 'The external system no longer has this session, so the thread ended. The parent thread was notified.', plain: true });
        } else {
          this.push({ kind: 'error', key, at, icon: 'octagon-x', title: 'Thread crashed', text: event.payload.error });
        }
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
      this.push({ kind: 'sys', key, at, icon: 'square', level: 'normal', text: `${who(event) === 'you' ? (this.ctx.you ?? 'You') : who(event)} stopped the turn — the agent halted and is awaiting a message` });

      return;
    }

    // The one-hop commands: the words of who asked. Finish — the agent
    // wraps up and ends the thread with its report (a remote session, with
    // its closing summary); pause — a remote thread's. A decision
    // (thread.decide) draws no line of its own: the resolved card says it
    // (agent.ask.resolved, with who decided).
    if (is(event, 'thread.finish')) {
      this.push({ kind: 'sys', key, at, icon: 'flag', level: 'normal', text: `${who(event) === 'you' ? (this.ctx.you ?? 'You') : who(event)} asked the agent to finish the thread — it wraps up and ends with its report` });

      return;
    }

    if (is(event, 'thread.pause')) {
      this.push({ kind: 'sys', key, at, icon: 'moon', level: 'normal', text: `${who(event) === 'you' ? (this.ctx.you ?? 'You') : who(event)} paused the thread` });

      return;
    }

    if (is(event, 'thread.decide')) {
      return;
    }

    // A question for the user: a message card with the options as quick
    // replies, static once resolved.
    if (is(event, 'agent.ask')) {
      const { askId, kind: askKind, text, link, options } = event.payload;

      this.push({
        kind: 'message',
        key,
        at,
        from: event.agentName ?? this.ctx.agent,
        to: 'you',
        variant: 'ask',
        text,
        atts: [],
        fold: false,
        ask: { threadId: this.ctx.threadId, askId, askKind, options: Array.isArray(options) ? options : [], link: typeof link === 'string' ? link : null, outcome: null, decidedBy: null, decidedAt: null },
      });

      return;
    }

    if (is(event, 'agent.ask.resolved')) {
      const card = this.items.find((item): item is MessageItem => item.kind === 'message' && item.ask?.askId === event.payload.askId && item.ask.outcome === null);

      if (card) {
        // Decided from Balabash — the operator by name (the name Settings
        // holds, else the identity's); closed in the external system — no one.
        const identity = event.payload.by?.identity;

        card.ask = { ...card.ask!, outcome: event.payload.outcome, decidedBy: identity ? (this.ctx.you ?? identity.username ?? 'you') : null, decidedAt: identity ? at : null };
      } else {
        this.push({ kind: 'sys', key, at, icon: 'check', text: `Question resolved: ${event.payload.outcome}` });
      }

      return;
    }

    if (is(event, 'thread.progress')) {
      this.push({ kind: 'sys', key, at, icon: 'flag', level: 'normal', text: event.payload.text });

      return;
    }

    if (is(event, 'thread.notification')) {
      this.push({ kind: 'sys', key, at, ...notificationIcon(event.payload.level, event.payload.text), text: event.payload.text });

      return;
    }

    if (is(event, 'thread.message')) {
      const text = event.payload.text;
      const atts = Array.isArray(event.payload.files) && event.payload.files.length > 0 ? messageFileAtts(event.payload.files, key) : fileIdAtts(event.payload.fileIds ?? [], key);

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
      const atts = userAtts(event.payload, key);

      // A reply somebody else wrote into a remote session (the engine's
      // mirror, source 'remote'): their words under their name, not yours.
      if (event.payload.source === 'remote') {
        this.push({ kind: 'message', key, at, from: event.payload.identity?.username || 'external', to: this.ctx.agent, tag: 'external', text, atts, fold: shouldFold(text) });

        return;
      }

      this.push({ kind: 'message', key, at, from: 'you', to: this.ctx.agent, variant: 'user', text, atts, fold: false });

      return;
    }

    if (is(event, 'agent.message')) {
      const content = Array.isArray(event.payload.content) ? event.payload.content : [];
      const text = contentText(content);

      this.push({ kind: 'message', key, at, from: event.agentName ?? this.ctx.agent, to: 'you', text, atts: contentAtts(content, key), fold: false });

      return;
    }

    if (is(event, 'session.tool.started') && this.unplaced(event.payload.parentToolUseId)) {
      this.unplacedCalls.add(event.payload.toolUseId);

      return;
    }

    if ((is(event, 'session.thinking') || is(event, 'session.text')) && this.unplaced(event.payload.parentToolUseId)) {
      return;
    }

    if (is(event, 'session.thinking')) {
      // The event is written when the thought ends; a measured one began
      // durationMs earlier — the row's duration, as a tool's. Unmeasured
      // (older history, nothing to measure from) — no time.
      const { durationMs } = event.payload;
      const timed = typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs >= 0;

      this.action({ kind: 'action', key, at: timed ? new Date(at.getTime() - durationMs) : at, state: 'done', label: { icon: 'brain', text: 'Thought' }, endedAt: at, ...(timed ? {} : { untimed: true as const }), endNote: null, detail: { kind: 'md', text: event.payload.text }, nested: [] }, event.payload.parentToolUseId);

      return;
    }

    if (is(event, 'session.text')) {
      this.place({ kind: 'quiet', key, at, text: event.payload.text }, event.payload.parentToolUseId);

      return;
    }

    if (is(event, 'session.tool.started')) {
      if (isPlanTool(event.payload.name)) {
        return;
      }

      const { label, detail, add, del } = nativeAction(event.payload.name, event.payload.input ?? {});
      const item = this.open({ kind: 'action', key, at, state: 'run', label, endedAt: null, endNote: null, ...(add !== undefined ? { add } : {}), ...(del !== undefined ? { del } : {}), detail, nested: [] });

      this.tools.set(event.payload.toolUseId, item);
      this.toolIds.set(item, event.payload.toolUseId);

      if (event.payload.parentToolUseId) {
        this.callParents.set(event.payload.toolUseId, event.payload.parentToolUseId);
      }

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

      // A sub-agent's call whose Agent row is out of range; the end of an
      // Agent whose report row already tells what it brought back.
      if (isPlanTool(event.payload.name) || this.unplaced(event.payload.parentToolUseId) || this.reports.has(event.payload.toolUseId)) {
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
      // A call of a sub-agent not drawn is represented under its Agent row
      // once that is loaded, its tasks with it.
      const tool = event.payload.toolUseId ? this.tools.get(event.payload.toolUseId) : undefined;

      if ((tool && tool.label.tool !== 'Agent' && !event.payload.backgrounded) || (event.payload.toolUseId && this.unplacedCalls.has(event.payload.toolUseId))) {
        return;
      }

      // The harness announces a backgrounded task again when its late
      // output arrives (a second started and completed of the same taskId):
      // the card stays where it first appeared and runs again.
      // The kind names the agent when there is one, backgrounded or not; a
      // background task is a backgrounded call without an agent (Bash).
      const taskKind = event.payload.subagentType ? `${event.payload.subagentType} subagent` : event.payload.backgrounded ? 'background task' : 'subagent';
      const known = this.tasks.get(event.payload.taskId);

      if (known) {
        known.state = this.runState;
        known.taskKind = taskKind;

        // A card the end alone made (its start before the loaded range)
        // stood its summary in for the description; the start brings the
        // description, and the summary takes its own place.
        if (known.summary === null && known.description !== event.payload.description) {
          known.summary = known.description;
        }

        known.description = event.payload.description;

        return;
      }

      const item: SubtaskItem = {
        kind: 'subtask',
        key,
        at,
        taskKind,
        description: event.payload.description,
        state: this.runState,
        meta: [],
        lastTool: null,
        summary: null,
      };

      this.tasks.set(event.payload.taskId, item);
      // A sub-agent's sub-agent: its card goes under the row of the one
      // that ran it.
      this.place(item, event.payload.toolUseId ? this.callParents.get(event.payload.toolUseId) : undefined);

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
      } else if (!event.payload.toolUseId) {
        // The start is before the loaded range. A task bound to a tool use is
        // represented by that tool's row (an end alone when its start is out
        // of range too); a task of its own gets its card from the end — and
        // the card is the task's, so a later announcement of the same taskId
        // (the harness announces a backgrounded task again) runs it again
        // where it is instead of making a second one.
        const card: SubtaskItem = { kind: 'subtask', key, at, taskKind: 'task', description: event.payload.summary, state, meta: taskMeta(event.payload.usage), lastTool: null, summary: null };

        this.tasks.set(event.payload.taskId, card);
        this.push(card);
      }

      this.report(event, `${key}:report`, at, state, item);

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
      const item = this.open({ kind: 'action', key, at, state: 'run', label, endedAt: null, endNote: null, detail: { kind: 'io', input, output: null }, nested: [] });

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

    if (is(event, 'oauth_client.requested') || is(event, 'secrets.requested')) {
      this.push({ kind: 'sys', key, at, icon: 'key-round', state: 'act', text: `${event.payload.server}: ${event.type === 'secrets.requested' ? 'secrets' : 'OAuth client'} requested` });

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
