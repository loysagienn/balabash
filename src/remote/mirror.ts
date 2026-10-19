// The mirror: one read of the driver (RemoteRead) turned into the events of
// the thread's journal and the next watch state — a pure function, the
// vocabulary of the platform (engine.ts tells the whole of it). The
// engine writes the events and the new state in one transaction with the
// cursor (store.ts), so this function must be deterministic over its
// inputs: no clock, no randomness, no lookups.
//
// The owner decides the surface: in an ordinary thread the agent's text is
// an agent.message to the user; in a headless thread it is a thread.message
// to the parent — and so is whatever the parent would otherwise wait for
// in vain: a question of the agent, a turn that failed. Everything else
// (tool calls, asks, state) is the same in both.

import type { ContentBlock, JsonObject, NotificationLevel, RemoteItem, RemoteRead } from '../core/contract.ts';
import type { AppendInput } from '../core/envelope.ts';
import { AGENT_ASK, AGENT_ASK_RESOLVED, THREAD_MESSAGE, THREAD_NOTIFICATION } from '../core/envelope.ts';
import type { SessionState } from '../projections/session.ts';
import type { RemotePhase, WatchState } from './store.ts';
import { OWN_IDS_KEEP } from './store.ts';

export type MirrorContext = {
  threadId: string;
  workspaceId: string;
  kind: string;
  // The watch before the read: the closing summary in flight (watch.finish)
  // keeps the phase at finishing whatever the session says of itself.
  watch: WatchState;
};

export type MirrorResult = {
  events: AppendInput[];
  watch: WatchState;
  // The session's phase after the read — the driver's word, refined by the
  // open asks; 'gone' when the session is lost.
  phase: Exclude<RemotePhase, 'closed' | 'paused'>;
  // Something happened on the other side: a turn boundary, a reply, a
  // question — the pause clock restarts; a paused thread wakes.
  activity: boolean;
  // The closing summary's turn finished: its text (the finish flow).
  finished: { text: string } | null;
};

const NOTIFICATION_RANK: Record<NotificationLevel, number> = { silent: 0, normal: 1, urgent: 2 };

function clamp(level: NotificationLevel, policy: NotificationLevel): NotificationLevel {
  return NOTIFICATION_RANK[level] > NOTIFICATION_RANK[policy] ? policy : level;
}

export function stateOfPhase(phase: Exclude<RemotePhase, 'closed' | 'gone'>): SessionState {
  switch (phase) {
    case 'working':
    case 'finishing':
      return 'run';
    case 'asking':
      return 'act';
    case 'paused':
      return 'paused';
    default:
      return 'wait';
  }
}

// How the agent's text reaches the owner.
export function agentText(ctx: Pick<MirrorContext, 'threadId' | 'workspaceId' | 'kind' | 'watch'>, text: string): AppendInput {
  return ctx.watch.headless
    ? {
        type: THREAD_MESSAGE,
        actor: 'agent',
        agentName: ctx.kind,
        workspaceId: ctx.workspaceId,
        threadId: ctx.threadId,
        targetThreadId: ctx.watch.parentId,
        payload: { text },
      }
    : {
        type: 'agent.message',
        actor: 'agent',
        agentName: ctx.kind,
        workspaceId: ctx.workspaceId,
        threadId: ctx.threadId,
        payload: { content: [{ type: 'text', text }] as ContentBlock[] as unknown as JsonObject[] },
      };
}

export function notification(ctx: Pick<MirrorContext, 'threadId' | 'workspaceId' | 'kind' | 'watch'>, level: NotificationLevel, text: string): AppendInput {
  return {
    type: THREAD_NOTIFICATION,
    actor: 'agent',
    agentName: ctx.kind,
    workspaceId: ctx.workspaceId,
    threadId: ctx.threadId,
    payload: { level: clamp(level, ctx.watch.notification), text },
  };
}

function askWords(item: Extract<RemoteItem, { kind: 'ask.opened' }>): string {
  return `${item.text}${item.link ? ` — ${item.link}` : ''}`;
}

export function mirrorRead(read: RemoteRead, ctx: MirrorContext): MirrorResult {
  const { threadId, workspaceId, kind } = ctx;
  const events: AppendInput[] = [];
  let watch: WatchState = { ...ctx.watch, openAsks: [...ctx.watch.openAsks], resolvedAsks: [...ctx.watch.resolvedAsks] };
  let activity = false;
  let finished: MirrorResult['finished'] = null;
  // The turns that failed through an error item: turn.finished of those
  // needs no second notification. An error names no turn — the open one is
  // taken.
  const erroredTurns = new Set<string>();
  let currentTurnId: string | null = null;
  const author = (): Pick<AppendInput, 'actor' | 'agentName' | 'workspaceId' | 'threadId'> => ({ actor: 'agent', agentName: kind, workspaceId, threadId });
  const says = (level: NotificationLevel, text: string) => events.push(notification({ threadId, workspaceId, kind, watch }, level, text));
  const tells = (text: string) => events.push(agentText({ threadId, workspaceId, kind, watch }, text));
  // A turn that failed: the notification says so (the owner of an ordinary
  // thread reads it in the thread and the bell); the parent of a headless
  // thread is told as well — it is waiting for a reply, and none is coming.
  const failed = (level: NotificationLevel, notice: string, reason: string) => {
    says(level, notice);

    if (watch.headless) {
      events.push({
        type: THREAD_MESSAGE,
        ...author(),
        targetThreadId: watch.parentId,
        payload: { text: `[The turn failed — the session stays open and waits for your next message] ${reason}` },
      });
    }
  };

  if (read.resynced) {
    says('silent', 'The mirror was resynchronised with the session.');
  }

  for (const item of read.items) {
    switch (item.kind) {
      case 'turn.started': {
        activity = true;
        currentTurnId = item.turnId;
        watch = { ...watch, lastTurnText: '' };

        // The closing summary's turn: told by our prompt's id — or, from a
        // driver that names no prompt, the first turn opened after the
        // summary was asked for.
        if (watch.finish && !watch.finish.turnId && (item.messageId === undefined || item.messageId === watch.finish.messageId)) {
          watch = { ...watch, finish: { ...watch.finish, turnId: item.turnId } };
        }

        break;
      }
      case 'prompt': {
        if (item.messageId && watch.ownMessageIds.includes(item.messageId)) {
          break; // the echo of our own prompt
        }

        activity = true;
        events.push({
          type: 'user.message',
          actor: 'user',
          workspaceId,
          threadId,
          payload: { text: item.text, source: 'remote', identity: { username: item.author ?? 'external' } },
        });

        break;
      }
      case 'text': {
        if (!item.text.trim()) {
          break; // nothing said
        }

        watch = { ...watch, lastTurnText: item.text };

        // The closing summary is the thread's summary, not a reply.
        if (!(watch.finish && watch.finish.turnId === item.turnId)) {
          tells(item.text);
        }

        break;
      }
      case 'tool.started': {
        events.push({ type: 'tool.call.started', ...author(), payload: { callId: item.callId, functionName: item.name, input: item.input } });

        break;
      }
      case 'tool.finished': {
        events.push({
          type: 'tool.call.completed',
          ...author(),
          payload: {
            callId: item.callId,
            functionName: item.name,
            serverName: kind,
            toolName: item.name,
            result: { content: [{ type: 'text', text: item.output }], ...(item.isError ? { isError: true } : {}) },
          },
        });

        break;
      }
      case 'turn.finished': {
        activity = true;

        if (watch.finish && watch.finish.turnId === item.turnId) {
          finished = { text: item.text || watch.lastTurnText };
        } else if (item.outcome === 'failed' && !erroredTurns.has(item.turnId)) {
          failed('normal', 'The turn ended with an error.', 'The turn ended with an error.');
        }

        break;
      }
      case 'error': {
        if (!item.terminal) {
          says('normal', item.text);

          break;
        }

        failed('urgent', `The turn failed: ${item.text}`, item.text);

        if (currentTurnId) {
          erroredTurns.add(currentTurnId);
        }

        break;
      }
      case 'ask.opened': {
        if (watch.openAsks.some(ask => ask.askId === item.askId) || watch.resolvedAsks.includes(item.askId)) {
          break;
        }

        activity = true;
        watch = { ...watch, openAsks: [...watch.openAsks, { askId: item.askId, kind: item.askKind, options: item.options }] };
        events.push({
          type: AGENT_ASK,
          ...author(),
          payload: {
            askId: item.askId,
            kind: item.askKind,
            text: item.text,
            ...(item.link ? { link: item.link } : {}),
            options: item.options,
            ...(item.expiresAt ? { expiresAt: item.expiresAt } : {}),
          },
        });

        if (watch.headless) {
          events.push({
            type: THREAD_MESSAGE,
            ...author(),
            targetThreadId: watch.parentId,
            payload: { text: `[Needs a human's decision — relay it to the user, never decide yourself] ${askWords(item)}` },
          });
        } else {
          says('urgent', `Needs your decision: ${askWords(item)}`);
        }

        break;
      }
      case 'ask.closed': {
        watch = { ...watch, openAsks: watch.openAsks.filter(ask => ask.askId !== item.askId) };

        if (watch.resolvedAsks.includes(item.askId)) {
          // Decided from Balabash: agent.ask.resolved is already in the log.
          watch = { ...watch, resolvedAsks: watch.resolvedAsks.filter(askId => askId !== item.askId) };

          break;
        }

        activity = true;
        events.push({ type: AGENT_ASK_RESOLVED, ...author(), payload: { askId: item.askId, outcome: item.outcome } });

        break;
      }
      case 'artifact': {
        if (watch.headless) {
          tells(`${item.title}: ${item.uri}`);
        } else {
          events.push({
            type: 'agent.message',
            ...author(),
            payload: {
              content: [{ type: 'resource_link', uri: item.uri, name: item.title, ...(item.mimeType ? { mimeType: item.mimeType } : {}) }] as ContentBlock[] as unknown as JsonObject[],
            },
          });
        }

        break;
      }
    }
  }

  watch = { ...watch, ownMessageIds: watch.ownMessageIds.slice(-OWN_IDS_KEEP) };

  // The closing summary still outstanding keeps the thread finishing — an
  // idle read before the summary's turn starts (or a lost one) does not
  // reopen the thread; the engine's deadline settles it.
  const phase: MirrorResult['phase'] =
    read.phase === 'gone' ? 'gone' : watch.finish && !finished ? 'finishing' : read.phase === 'working' ? 'working' : read.phase === 'asking' || watch.openAsks.length ? 'asking' : 'idle';

  return { events, watch, phase, activity: activity || read.items.length > 0, finished };
}
