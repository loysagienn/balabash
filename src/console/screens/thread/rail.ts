// What the details rail reads: the model and effort of the session — an
// active one has them in the store's sessions (the newest session.started
// and the session-scope session.fallback after it, however far back), a
// finished one from the loaded events' session.started and session.fallback
// — the remote session's link (remoteLink of the start) alike, the latest
// session.context likewise, and the compactions of the loaded events.
// fallback — the session moved to `model` from another one: the model it
// left and the refusal category (projections/session.ts).

import type { Event } from '../../../core/contract.ts';
import type { EventOf } from '../../../core/event-types.ts';
import type { SessionView } from '../../../projections/session.ts';

export type RailFallback = { from: string; category: string | null };

export type RailSessionInfo = { model: string | null; effort: string | null; remoteLink: string | null; fallback: RailFallback | null; context: { used: number; max: number } | null; compactions: number };

// What the rail reads from the thread's loaded events.
export function railSessionInfo(events: readonly Event[], live: { used: number; max: number } | null, started?: SessionView['started'] | null): RailSessionInfo {
  let model: string | null = null;
  let effort: string | null = null;
  let remoteLink: string | null = null;
  let fallback: RailFallback | null = null;
  let context = live;
  let compactions = 0;

  for (const event of events) {
    if (event.type === 'session.started') {
      const payload = (event as EventOf<'session.started'>).payload;

      model = payload.model ?? model;
      effort = payload.effort ?? effort;
      remoteLink = payload.remoteLink ?? remoteLink;
      fallback = null;
    } else if (event.type === 'session.fallback') {
      const payload = (event as EventOf<'session.fallback'>).payload;

      if (payload.scope === 'session' && payload.to) {
        fallback ??= { from: payload.from, category: payload.category ?? null };
        model = payload.to;
      }
    } else if (event.type === 'session.context' && !live) {
      const payload = (event as EventOf<'session.context'>).payload;

      if (typeof payload.totalTokens === 'number' && typeof payload.maxTokens === 'number' && payload.maxTokens > 0) {
        context = { used: payload.totalTokens, max: payload.maxTokens };
      }
    } else if (event.type === 'session.compaction') {
      compactions += 1;
    }
  }

  return started
    ? { model: started.model, effort: started.effort, remoteLink: started.remoteLink ?? null, fallback: started.fallback ?? null, context, compactions }
    : { model, effort, remoteLink, fallback, context, compactions };
}

// A remote session's link as the rail shows it: the address without its
// scheme (the whole link is the title and the target).
export function remoteLinkLabel(link: string): string {
  return link.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
}

export function compactionsLabel(n: number): string {
  return n === 0 ? 'not compacted' : n === 1 ? 'compacted once' : n === 2 ? 'compacted twice' : `compacted ${n} times`;
}
