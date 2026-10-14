// The SDK session behind an active thread, folded from the session.* events
// of the log — shared by the snapshot (src/api/snapshot.ts) and the
// console's sessions reducer. Pure, node-free — the console bundles this
// file (src/console/tsconfig.json).

import type { JsonObject } from '../core/contract.ts';
import { threadStatusFrom } from './thread.ts';

// run — a turn is in flight; wait — the session idles for the next message;
// act — the session asks for an action (the SDK's requires_action, a remote
// session's question); paused — a remote session idle long enough (or
// paused by hand): the thread is alive but out of the active lists, woken
// by a message or by activity on the other side (src/remote).
export type SessionState = 'run' | 'wait' | 'act' | 'paused';

export type SessionView = {
  state: SessionState;
  // The context window of the inner session after its latest turn
  // (session.context): tokens used of the maximum; null until measured.
  context: { used: number; max: number } | null;
  // The model and the effort of the session (the newest session.started);
  // absent until one is folded — and in a snapshot of a server older than
  // the field.
  started?: { model: string; effort: string | null };
};

export const SESSION_EVENT_PREFIX = 'session.';

// The event types the view is folded from — the snapshot reads only these.
export const SESSION_VIEW_TYPES = ['session.state', 'session.context', 'session.started'] as const;

export function isSessionEvent(type: string): boolean {
  return type.startsWith(SESSION_EVENT_PREFIX);
}

// The state a session.state payload carries; null when it is not one of ours
// (the log is read tolerantly).
export function sessionStateFrom(payload: JsonObject): SessionState | null {
  const { state } = payload;

  return state === 'run' || state === 'wait' || state === 'act' || state === 'paused' ? state : null;
}

function sessionStartedFrom(payload: JsonObject): NonNullable<SessionView['started']> | null {
  const { model, effort } = payload;

  if (typeof model !== 'string' || model === '') {
    return null;
  }

  return { model, effort: typeof effort === 'string' && effort !== '' ? effort : null };
}

function sessionContextFrom(payload: JsonObject): SessionView['context'] {
  const { totalTokens, maxTokens } = payload;

  if (typeof totalTokens !== 'number' || typeof maxTokens !== 'number' || maxTokens <= 0) {
    return null;
  }

  return { used: totalTokens, max: maxTokens };
}

// The view after one event of the thread. Returns the same reference when
// the event changes nothing; null when the thread ended — a session of a
// finished thread is no session (the snapshot carries only active ones).
export function foldSession(view: SessionView | null, type: string, payload: JsonObject): SessionView | null {
  if (threadStatusFrom(type) !== null) {
    return null;
  }

  switch (type) {
    case 'session.state': {
      const state = sessionStateFrom(payload);

      if (state === null || view?.state === state) {
        return view;
      }

      return { ...view, state, context: view?.context ?? null };
    }
    case 'session.context': {
      const context = sessionContextFrom(payload);

      if (context === null) {
        return view;
      }

      return { ...view, state: view?.state ?? 'wait', context };
    }
    case 'session.started': {
      const started = sessionStartedFrom(payload);

      if (started === null || (view?.started?.model === started.model && view.started.effort === started.effort)) {
        return view;
      }

      return { state: view?.state ?? 'wait', context: view?.context ?? null, started };
    }
    default:
      return view;
  }
}
