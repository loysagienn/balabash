import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ConnectionView } from '../../../api/contract.ts';
import type { NotificationItem } from '../../store/notifications/reducer.ts';
import { thread } from '../../store/fixtures.ts';
import { clip, connectionKey, exceptionDesc, exceptionTitle, notificationViews, threadWords, unreadCount, unreadKeys } from './notifications.logic.ts';

const at = (minute: number) => new Date(2026, 9, 9, 17, minute);

const note = (seq: number, minute: number, text: string, level: 'normal' | 'urgent' = 'normal', threadId: string | null = 't1'): NotificationItem => ({ key: String(seq), seq: BigInt(seq), at: at(minute), kind: 'thread', level, text, threadId, agent: 'engineer' });

type ExceptionItem = Extract<NotificationItem, { kind: 'exception' }>;

const exception = (seq: number, minute: number, partial: Partial<ExceptionItem> = {}): ExceptionItem => ({
  key: String(seq),
  seq: BigInt(seq),
  at: at(minute),
  kind: 'exception',
  error: 'boom',
  threadId: null,
  consumerName: null,
  eventType: null,
  scope: null,
  slug: null,
  status: null,
  exitCode: null,
  ...partial,
});

const connection = (partial: Partial<ConnectionView> = {}): ConnectionView => ({
  id: 'c1',
  server: 'notion',
  accountKey: 'work',
  displayName: 'Work Notion',
  status: 'reauthorization_required',
  identity: 'v@example.com',
  scope: null,
  threadId: null,
  createdAt: at(0),
  updatedAt: at(5),
  ...partial,
});

const THREADS = { t1: thread({ id: 't1', title: 'Mini-apps: publishing by slug' }), main: thread({ id: 'main', parentId: null, agent: 'coordinator', title: null }) };
const base = { read: {}, connections: [], threads: THREADS, mainThreadId: 'main' };

describe('notifications', () => {
  it('groups the rows: waiting first, then errors, then the agents, newest first within a group', () => {
    const views = notificationViews({
      ...base,
      items: [note(1, 1, 'Build is green'), exception(2, 2, { consumerName: 'router', eventType: 'user.message' }), note(3, 3, 'Need the 2FA code', 'urgent'), exception(4, 4, { slug: 'db-backup', status: 'failed', exitCode: 127, error: '' })],
      connections: [connection()],
    });

    assert.deepEqual(
      views.map(view => [view.group, view.key]),
      [
        ['waiting', 'connection:c1:' + at(5).getTime()],
        ['errors', '4'],
        ['errors', '2'],
        ['agents', '3'],
        ['agents', '1'],
      ],
    );
    assert.equal(unreadCount(views), 5);
    assert.deepEqual(unreadKeys(views), views.map(view => view.key));
  });

  it('puts the later seq first among rows of one moment', () => {
    const views = notificationViews({ ...base, items: [note(1, 1, 'first'), note(2, 1, 'second'), exception(3, 1), exception(4, 1)] });

    assert.deepEqual(
      views.map(view => view.key),
      ['4', '3', '2', '1'],
    );
  });

  it('writes a message row from the agent: the first line as the title, who and where below, urgent tinted', () => {
    const [urgent, plain] = notificationViews({ ...base, items: [note(1, 1, '**Build is green**\n\nDetails below.'), note(2, 2, 'Need the 2FA code', 'urgent', 'main')] });

    assert.equal(plain.title, 'Build is green');
    assert.equal(plain.desc, 'engineer · Mini-apps: publishing by slug');
    assert.equal(plain.state, undefined);
    assert.equal(plain.icon, 'bell');
    assert.deepEqual(plain.action, { label: 'Open thread', route: { key: 'thread', id: 't1' } });
    assert.equal(urgent.state, 'act');
    assert.equal(urgent.desc, 'engineer · Main thread');
  });

  it('names the thread by what the store knows: the agent of its row, "untitled", no action without a thread', () => {
    assert.equal(threadWords({ agent: null, threadId: 'main', threads: THREADS, mainThreadId: 'main' }), 'coordinator · Main thread');
    assert.equal(threadWords({ agent: null, threadId: 'gone', threads: THREADS, mainThreadId: 'main' }), 'agent · untitled thread');
    assert.equal(threadWords({ agent: 'browser', threadId: null, threads: THREADS, mainThreadId: 'main' }), 'browser · untitled thread');

    const [view] = notificationViews({ ...base, items: [note(1, 1, 'x', 'normal', null)] });

    assert.equal(view.action, null);
  });

  it('writes an error row: a task by its slug and exit code, a consumer by its name and event, the rest plainly', () => {
    const task = exception(1, 1, { slug: 'db-backup', status: 'failed', exitCode: 127, error: 'bash: pg_dump: command not found\n  at …' });
    const consumer = exception(2, 2, { consumerName: 'router', eventType: 'thread.completed', error: 'boom', threadId: 'main' });
    const bare = exception(3, 3, { error: '' });

    assert.equal(exceptionTitle(task), 'Task “db-backup” failed');
    assert.equal(exceptionDesc(task), 'bash: pg_dump: command not found · exit code 127');
    assert.equal(exceptionTitle(exception(4, 4, { slug: 'db-backup', status: 'timed out' })), 'Task “db-backup” timed out');
    assert.equal(exceptionTitle(consumer), 'router failed on thread.completed');
    assert.equal(exceptionDesc(consumer), 'boom');
    assert.equal(exceptionTitle(bare), 'System exception');
    assert.equal(exceptionDesc(bare), '');
    assert.equal(exceptionDesc(exception(5, 5, { error: '', exitCode: 1 })), 'exit code 1');

    const [view] = notificationViews({ ...base, items: [consumer] });

    assert.equal(view.icon, 'circle-alert');
    assert.equal(view.state, 'err');
    assert.deepEqual(view.action, { label: 'Open thread', route: { key: 'thread', id: 'main' } });
  });

  it('writes the waiting row of a connection that needs signing in again, keyed by the moment its row changed', () => {
    const [view] = notificationViews({ ...base, items: [], connections: [connection(), connection({ id: 'c2', status: 'connected' })] });

    assert.equal(view.title, '“Work Notion” needs signing in again');
    assert.equal(view.desc, 'notion · v@example.com');
    assert.equal(view.icon, 'key-round');
    assert.deepEqual(view.action, { label: 'Open connections', route: { key: 'connections' } });
    assert.equal(notificationViews({ ...base, items: [], connections: [connection({ identity: null })] })[0].desc, 'notion');
    assert.equal(connectionKey(connection({ updatedAt: at(7) })), `connection:c1:${at(7).getTime()}`);
  });

  it('counts the unread: a read key is read, the same connection changed again is new', () => {
    const key = connectionKey(connection());
    const views = notificationViews({ ...base, items: [note(1, 1, 'a'), note(2, 2, 'b')], connections: [connection()], read: { '1': true, [key]: true } });

    assert.deepEqual(
      views.map(view => [view.key, view.unread]),
      [
        [key, false],
        ['2', true],
        ['1', false],
      ],
    );
    assert.equal(unreadCount(views), 1);
    assert.deepEqual(unreadKeys(views), ['2']);

    const changed = notificationViews({ ...base, items: [], connections: [connection({ updatedAt: at(9) })], read: { [key]: true } });

    assert.equal(changed[0].unread, true);
  });

  it('clips a long line with an ellipsis', () => {
    assert.equal(clip('  short  ', 10), 'short');
    assert.equal(clip('a'.repeat(12), 10), `${'a'.repeat(9)}…`);
    assert.equal(clip('word word word', 7), 'word w…');
  });
});
