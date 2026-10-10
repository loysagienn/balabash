// What the bell holds of the log (design: Bell, Notification): the
// thread.notification events of the agents (normal and urgent — a silent
// one is the feed's alone) and the system.exception events, as the tail
// brings them — the snapshot carries none, so the bell starts empty with
// the tab and fills while it is open. The newest KEEP stay, in seq order,
// a seq already held is ignored (a reconnected tail overlaps). What awaits
// the user is not stored here: a connection that needs signing in again is
// read from the connections domain (features/notifications). `read` — the
// keys the user has seen (store/notifications/actions.ts), pruned with the
// items that leave.

import type { NotificationLevel } from '../../../core/contract.ts';
import { isEventAction } from '../events.ts';
import type { Action } from '../types.ts';

export type NotificationItem =
  | { key: string; seq: bigint; at: Date; kind: 'thread'; level: Exclude<NotificationLevel, 'silent'>; text: string; threadId: string | null; agent: string | null }
  | {
      key: string;
      seq: bigint;
      at: Date;
      kind: 'exception';
      error: string;
      threadId: string | null;
      consumerName: string | null;
      eventType: string | null;
      scope: string | null;
      slug: string | null;
      status: string | null;
      exitCode: number | null;
    };

export type NotificationsState = {
  items: NotificationItem[];
  read: Record<string, true>;
};

export const KEEP = 50;

export const initialNotifications: NotificationsState = { items: [], read: {} };

// The item in seq order; the oldest beyond KEEP leave, their read marks with them.
function withItem(state: NotificationsState, item: NotificationItem): NotificationsState {
  if (state.items.some(held => held.seq === item.seq)) {
    return state;
  }

  const at = state.items.findIndex(held => held.seq > item.seq);
  const items = at < 0 ? [...state.items, item] : [...state.items.slice(0, at), item, ...state.items.slice(at)];
  const gone = items.splice(0, Math.max(0, items.length - KEEP));

  if (gone.length === 0 || !gone.some(held => state.read[held.key])) {
    return { ...state, items };
  }

  const read = { ...state.read };

  for (const held of gone) {
    delete read[held.key];
  }

  return { items, read };
}

export function notificationsReducer(state: NotificationsState = initialNotifications, action: Action): NotificationsState {
  switch (action.type) {
    case 'NOTIFICATIONS_READ': {
      const fresh = action.keys.filter(key => !state.read[key]);

      if (fresh.length === 0) {
        return state;
      }

      const read = { ...state.read };

      for (const key of fresh) {
        read[key] = true;
      }

      return { ...state, read };
    }
    default: {
      if (!isEventAction(action)) {
        return state;
      }

      const { event } = action;
      const key = String(event.seq);

      if (action.type === 'event/thread.notification') {
        const { level, text } = action.event.payload;

        if (level === 'silent' || typeof text !== 'string') {
          return state;
        }

        return withItem(state, { key, seq: event.seq, at: event.createdAt, kind: 'thread', level: level === 'urgent' ? 'urgent' : 'normal', text, threadId: event.threadId, agent: event.agentName });
      }

      if (action.type === 'event/system.exception') {
        const payload = action.event.payload;

        return withItem(state, {
          key,
          seq: event.seq,
          at: event.createdAt,
          kind: 'exception',
          error: typeof payload.error === 'string' ? payload.error : '',
          threadId: event.threadId ?? event.targetThreadId ?? null,
          consumerName: payload.consumerName ?? null,
          eventType: payload.eventType ?? null,
          scope: payload.scope ?? null,
          slug: payload.slug ?? null,
          status: payload.status ?? null,
          exitCode: typeof payload.exitCode === 'number' ? payload.exitCode : null,
        });
      }

      return state;
    }
  }
}
