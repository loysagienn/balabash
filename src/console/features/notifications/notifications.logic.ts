// The rows of the bell (design: App Shell, "Activity and notifications"):
// first what awaits the user, then the errors, then the messages of the
// agents; within a group the newest first. The waiting rows are read from
// the connections — an account that needs signing in again (the secrets a
// connection asks for are not in the log yet: backlog). An error is a
// system.exception of the tail; a message is a thread.notification, urgent
// ones tinted. A row is unread until its action is pressed or "Mark all
// read"; the count on the bell is the unread rows. The keys: an event's
// seq, a connection's id with the moment its row changed — a connection
// that needs signing in again after a reconnect is a new row.

import type { ConnectionView } from '../../../api/contract.ts';
import type { Thread } from '../../../core/contract.ts';
import type { AppRoute } from '../../lib/router/routes.ts';
import { plainLine } from '../../lib/format/plain.ts';
import type { NotificationItem } from '../../store/notifications/reducer.ts';
import type { IconName } from '../../ui/Icon/Icon.tsx';

export type NotificationGroup = 'waiting' | 'errors' | 'agents';

export const GROUPS: readonly { key: NotificationGroup; label: string }[] = [
  { key: 'waiting', label: 'Waiting for you' },
  { key: 'errors', label: 'Errors' },
  { key: 'agents', label: 'From agents' },
];

export type NotificationView = {
  key: string;
  group: NotificationGroup;
  icon: IconName;
  state: 'act' | 'err' | undefined;
  title: string;
  desc: string;
  action: { label: string; route: AppRoute } | null;
  at: Date;
  unread: boolean;
};

export type NotificationsInput = {
  items: readonly NotificationItem[];
  read: Readonly<Record<string, true>>;
  connections: readonly ConnectionView[];
  threads: Readonly<Record<string, Thread>>;
  mainThreadId: string | null;
};

// The words of one line, no longer than the row can hold.
const TITLE_MAX = 120;
const DESC_MAX = 200;

export function clip(text: string, max: number): string {
  const line = text.trim();

  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

// The first line of a text that is not Markdown (an error), trimmed.
function firstLine(text: string): string {
  return text.split('\n').find(line => line.trim()) ?? '';
}

function openThread(threadId: string | null): NotificationView['action'] {
  return threadId ? { label: 'Open thread', route: { key: 'thread', id: threadId } } : null;
}

export function connectionKey(connection: ConnectionView): string {
  return `connection:${connection.id}:${connection.updatedAt.getTime()}`;
}

// "engineer · Mini-apps: publishing by slug" — who and where.
export function threadWords(input: { agent: string | null; threadId: string | null; threads: Readonly<Record<string, Thread>>; mainThreadId: string | null }): string {
  const thread = input.threadId ? input.threads[input.threadId] : undefined;
  const agent = input.agent ?? thread?.agent ?? 'agent';
  const where = input.threadId && input.threadId === input.mainThreadId ? 'Main thread' : (thread?.title ?? 'untitled thread');

  return `${agent} · ${where}`;
}

export function exceptionTitle(item: Extract<NotificationItem, { kind: 'exception' }>): string {
  if (item.slug) {
    return `Task “${item.slug}” ${item.status === 'failed' || item.status === null ? 'failed' : item.status}`;
  }
  if (item.consumerName) {
    return `${item.consumerName} failed${item.eventType ? ` on ${item.eventType}` : ''}`;
  }

  return 'System exception';
}

export function exceptionDesc(item: Extract<NotificationItem, { kind: 'exception' }>): string {
  const error = clip(firstLine(item.error), DESC_MAX);

  return item.exitCode === null ? error : `${error}${error ? ' · ' : ''}exit code ${item.exitCode}`;
}

function viewOf(item: NotificationItem, input: NotificationsInput): NotificationView {
  const unread = !input.read[item.key];

  if (item.kind === 'exception') {
    return { key: item.key, group: 'errors', icon: 'circle-alert', state: 'err', title: exceptionTitle(item), desc: exceptionDesc(item), action: openThread(item.threadId), at: item.at, unread };
  }

  return {
    key: item.key,
    group: 'agents',
    icon: 'bell',
    state: item.level === 'urgent' ? 'act' : undefined,
    title: clip(plainLine(item.text), TITLE_MAX),
    desc: threadWords({ agent: item.agent, threadId: item.threadId, threads: input.threads, mainThreadId: input.mainThreadId }),
    action: openThread(item.threadId),
    at: item.at,
    unread,
  };
}

function waitingOf(connection: ConnectionView, input: NotificationsInput): NotificationView {
  const key = connectionKey(connection);

  return {
    key,
    group: 'waiting',
    icon: 'key-round',
    state: 'act',
    title: `“${connection.displayName}” needs signing in again`,
    desc: connection.identity ? `${connection.server} · ${connection.identity}` : connection.server,
    action: { label: 'Open connections', route: { key: 'connections' } },
    at: connection.updatedAt,
    unread: !input.read[key],
  };
}

const ORDER: Record<NotificationGroup, number> = { waiting: 0, errors: 1, agents: 2 };

// The groups in the design's order, the newest first within a group; two
// events of one moment (a tail's frame) — the later seq first (the sort is
// stable, the items are read newest first).
export function notificationViews(input: NotificationsInput): NotificationView[] {
  const items = [...input.items].sort((a, b) => (a.seq === b.seq ? 0 : a.seq < b.seq ? 1 : -1));
  const views = [...input.connections.filter(connection => connection.status === 'reauthorization_required').map(connection => waitingOf(connection, input)), ...items.map(item => viewOf(item, input))];

  return views.sort((a, b) => ORDER[a.group] - ORDER[b.group] || b.at.getTime() - a.at.getTime());
}

export function unreadCount(views: readonly NotificationView[]): number {
  return views.reduce((n, view) => n + (view.unread ? 1 : 0), 0);
}

export function unreadKeys(views: readonly NotificationView[]): string[] {
  return views.filter(view => view.unread).map(view => view.key);
}
