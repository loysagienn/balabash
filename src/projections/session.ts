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
  // the field. remoteLink — a remote session's address in the external
  // system (src/remote), present for remote sessions alone. fallback — the
  // session moved to `model` from the model it started on (a session-scope
  // session.fallback after the start; the first one's `from` stays through
  // later hops): from, and the refusal category of the first hop (null when
  // the API named none or the switch was observed without a notice).
  started?: { model: string; effort: string | null; remoteLink?: string; fallback?: { from: string; category: string | null } };
};

export const SESSION_EVENT_PREFIX = 'session.';

// The event types the view is folded from — the snapshot reads only these,
// and folds them in seq order (a fallback older than the newest start is
// the previous session's and must fold before it).
export const SESSION_VIEW_TYPES = ['session.state', 'session.context', 'session.started', 'session.fallback'] as const;

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
  const { model, effort, remoteLink } = payload;

  if (typeof model !== 'string' || model === '') {
    return null;
  }

  return {
    model,
    effort: typeof effort === 'string' && effort !== '' ? effort : null,
    ...(typeof remoteLink === 'string' && remoteLink !== '' ? { remoteLink } : {}),
  };
}

// A session-scope fallback: the model the session moves to and the one it
// leaves; null for a sub-agent's (local) fallback or a malformed payload.
function sessionFallbackFrom(payload: JsonObject): { from: string; to: string; category: string | null } | null {
  const { from, to, scope, category } = payload;

  if (scope !== 'session' || typeof from !== 'string' || from === '' || typeof to !== 'string' || to === '') {
    return null;
  }

  return { from, to, category: typeof category === 'string' && category !== '' ? category : null };
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

      if (started === null || (view?.started?.model === started.model && view.started.effort === started.effort && view.started.remoteLink === started.remoteLink)) {
        return view;
      }

      return { state: view?.state ?? 'wait', context: view?.context ?? null, started };
    }
    case 'session.fallback': {
      const fallback = sessionFallbackFrom(payload);

      if (fallback === null || view?.started?.model === fallback.to) {
        return view;
      }

      // A fallback before any start names the model the session runs on
      // now; the effort stays unknown.
      const started = view?.started ?? { model: fallback.from, effort: null };

      return {
        state: view?.state ?? 'wait',
        context: view?.context ?? null,
        started: { ...started, model: fallback.to, fallback: started.fallback ?? { from: fallback.from, category: fallback.category } },
      };
    }
    default:
      return view;
  }
}
