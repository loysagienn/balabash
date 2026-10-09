// What the details rail reads from a thread's loaded events: the model and
// effort of session.started, the latest session.context of a finished
// thread (an active one has it in the store's sessions), the compactions.

import type { Event } from '../../../core/contract.ts';
import type { EventOf } from '../../../core/event-types.ts';

export type RailSessionInfo = { model: string | null; effort: string | null; context: { used: number; max: number } | null; compactions: number };

// What the rail reads from the thread's loaded events.
export function railSessionInfo(events: readonly Event[], live: { used: number; max: number } | null): RailSessionInfo {
  let model: string | null = null;
  let effort: string | null = null;
  let context = live;
  let compactions = 0;

  for (const event of events) {
    if (event.type === 'session.started') {
      const payload = (event as EventOf<'session.started'>).payload;

      model = payload.model ?? model;
      effort = payload.effort ?? effort;
    } else if (event.type === 'session.context' && !live) {
      const payload = (event as EventOf<'session.context'>).payload;

      if (typeof payload.totalTokens === 'number' && typeof payload.maxTokens === 'number' && payload.maxTokens > 0) {
        context = { used: payload.totalTokens, max: payload.maxTokens };
      }
    } else if (event.type === 'session.compaction') {
      compactions += 1;
    }
  }

  return { model, effort, context, compactions };
}

export function compactionsLabel(n: number): string {
  return n === 0 ? 'not compacted' : n === 1 ? 'compacted once' : n === 2 ? 'compacted twice' : `compacted ${n} times`;
}

