import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ConnectionView } from '../../../api/contract.ts';
import { notificationViews, unreadCount } from '../../features/notifications/notifications.logic.ts';
import { connectionsReducer } from '../connections/reducer.ts';
import type { ConnectionsState } from '../connections/reducer.ts';
import { eventAction } from '../events.ts';
import { event, resetSeq } from '../fixtures.ts';
import { markNotificationsRead } from './actions.ts';
import { KEEP, connectionReadKey, initialNotifications, notificationsReducer } from './reducer.ts';
import type { NotificationsState } from './reducer.ts';

const reduce = (state: NotificationsState, ...events: Parameters<typeof event>[0][]) => events.reduce((acc, item) => notificationsReducer(acc, eventAction(event(item))), state);

describe('notifications reducer', () => {
  it('holds the notifications of agents and the exceptions of the tail, in seq order, silent ones aside', () => {
    resetSeq(10n);

    const state = reduce(
      initialNotifications,
      { type: 'thread.notification', threadId: 't1', payload: { text: 'Build is green', level: 'normal' } },
      { type: 'thread.notification', threadId: 't1', payload: { text: 'quiet', level: 'silent' } },
      { type: 'thread.progress', threadId: 't1', payload: { text: 'working' } },
      { type: 'system.exception', actor: 'system', targetThreadId: 'main', payload: { error: 'boom', consumerName: 'router', eventType: 'user.message' } },
      { type: 'thread.notification', threadId: 't2', agentName: 'browser', payload: { text: 'Need the 2FA code', level: 'urgent' } },
    );

    assert.deepEqual(
      state.items.map(item => [item.key, item.kind]),
      [
        ['10', 'thread'],
        ['13', 'exception'],
        ['14', 'thread'],
      ],
    );
    assert.deepEqual(state.items[0], { key: '10', seq: 10n, at: new Date(1_700_000_010_000), kind: 'thread', level: 'normal', text: 'Build is green', threadId: 't1', agent: 'engineer' });
    assert.deepEqual(state.items[1], {
      key: '13',
      seq: 13n,
      at: new Date(1_700_000_013_000),
      kind: 'exception',
      error: 'boom',
      threadId: 'main',
      consumerName: 'router',
      eventType: 'user.message',
      scope: null,
      slug: null,
      status: null,
      exitCode: null,
    });
    assert.equal(state.items[2].kind === 'thread' && state.items[2].level, 'urgent');
    assert.equal(state.items[2].kind === 'thread' && state.items[2].agent, 'browser');
  });

  it('reads a task exception with its scope, slug, status and exit code', () => {
    resetSeq(20n);

    const state = reduce(initialNotifications, { type: 'system.exception', actor: 'system', payload: { error: 'exit 127', scope: 'task', slug: 'db-backup', runId: 'r1', status: 'failed', exitCode: 127 } });

    assert.deepEqual(state.items[0], {
      key: '20',
      seq: 20n,
      at: new Date(1_700_000_020_000),
      kind: 'exception',
      error: 'exit 127',
      threadId: null,
      consumerName: null,
      eventType: null,
      scope: 'task',
      slug: 'db-backup',
      status: 'failed',
      exitCode: 127,
    });
  });

  it('ignores a seq it already holds and a late lower seq lands in its place', () => {
    resetSeq(30n);

    const first = reduce(initialNotifications, { type: 'thread.notification', threadId: 't1', payload: { text: 'one', level: 'normal' } });
    const again = notificationsReducer(first, eventAction(event({ seq: 30n, type: 'thread.notification', threadId: 't1', payload: { text: 'one again', level: 'normal' } })));

    assert.equal(again, first);

    const later = reduce(first, { seq: 35n, type: 'thread.notification', threadId: 't1', payload: { text: 'three', level: 'normal' } });
    const late = reduce(later, { seq: 32n, type: 'thread.notification', threadId: 't1', payload: { text: 'two', level: 'normal' } });

    assert.deepEqual(
      late.items.map(item => item.key),
      ['30', '32', '35'],
    );
  });

  it('keeps the newest KEEP, dropping the read marks of the ones that leave', () => {
    resetSeq(100n);

    let state = reduce(initialNotifications, { type: 'thread.notification', threadId: 't1', payload: { text: 'first', level: 'normal' } });

    state = notificationsReducer(state, markNotificationsRead(['100']));

    for (let i = 0; i < KEEP; i += 1) {
      state = reduce(state, { type: 'thread.notification', threadId: 't1', payload: { text: `n${i}`, level: 'normal' } });
    }

    assert.equal(state.items.length, KEEP);
    assert.equal(state.items[0].key, '101');
    assert.deepEqual(state.read, {});
  });

  it('marks keys read once; marking what is read already changes nothing', () => {
    const marked = notificationsReducer(initialNotifications, markNotificationsRead(['1', 'connection:c1:5']));

    assert.deepEqual(marked.read, { '1': true, 'connection:c1:5': true });
    assert.equal(notificationsReducer(marked, markNotificationsRead(['1'])), marked);
    assert.equal(notificationsReducer(marked, markNotificationsRead([])), marked);
    assert.deepEqual(notificationsReducer(marked, markNotificationsRead(['1', '2'])).read, { '1': true, '2': true, 'connection:c1:5': true });
  });

  // The waiting row of a connection, through the real connections reducer
  // and the rows of the bell: one read mark per episode of waiting.
  it('keeps a connection read through a rename and a failed attempt, unread again on a new episode, pruned when the row goes', () => {
    resetSeq(200n);

    const c1: ConnectionView = { id: 'c1', server: 'notion', accountKey: 'work', displayName: 'Work Notion', status: 'connected', identity: 'v@example.com', scope: null, threadId: null, createdAt: new Date(1_700_000_000_000), updatedAt: new Date(1_700_000_000_000) };
    const about = { connectionId: 'c1', server: 'notion', account: 'work', name: 'Work Notion' };
    let connections: ConnectionsState = { byId: { c1 }, ids: ['c1'], catalog: [] };
    let notifications = initialNotifications;
    const step = (partial: Parameters<typeof event>[0]) => {
      const action = eventAction(event(partial));

      connections = connectionsReducer(connections, action);
      notifications = notificationsReducer(notifications, action);
    };
    const rows = () => notificationViews({ items: notifications.items, read: notifications.read, connections: connections.ids.map(id => connections.byId[id]), threads: {}, mainThreadId: 'main' });

    step({ type: 'connection.reauthorization_required', actor: 'system', agentName: null, payload: { ...about, error: 'token revoked' } });
    assert.deepEqual(
      rows().map(row => [row.key, row.unread]),
      [['connection:c1', true]],
    );

    notifications = notificationsReducer(notifications, markNotificationsRead(['connection:c1']));
    assert.equal(unreadCount(rows()), 0);

    step({ type: 'connection.renamed', payload: { ...about, name: 'Work Notion (team)', previousName: 'Work Notion' } });
    step({ type: 'connection.failed', payload: { ...about, name: 'Work Notion (team)', error: 'consent denied' } });
    assert.equal(connections.byId.c1.displayName, 'Work Notion (team)');
    assert.equal(connections.byId.c1.status, 'reauthorization_required');
    assert.notEqual(connections.byId.c1.updatedAt.getTime(), c1.updatedAt.getTime());
    assert.deepEqual(
      rows().map(row => [row.title, row.unread]),
      [['“Work Notion (team)” needs signing in again', false]],
    );

    step({ type: 'connection.completed', payload: { ...about, name: 'Work Notion (team)', identity: 'v@example.com' } });
    assert.equal(connections.byId.c1.status, 'connected');
    assert.deepEqual(rows(), []);
    assert.deepEqual(notifications.read, {});

    step({ type: 'connection.reauthorization_required', actor: 'system', agentName: null, payload: { ...about, error: 'token revoked again' } });
    assert.deepEqual(
      rows().map(row => [row.key, row.unread]),
      [['connection:c1', true]],
    );

    notifications = notificationsReducer(notifications, markNotificationsRead([connectionReadKey('c1')]));
    step({ type: 'connection.disconnected', payload: { ...about, name: 'Work Notion (team)' } });
    assert.deepEqual(rows(), []);
    assert.deepEqual(notifications.read, {});

    // A boundary event of a row never marked changes nothing.
    assert.equal(notificationsReducer(notifications, eventAction(event({ type: 'connection.completed', payload: { ...about, connectionId: 'c9' } }))), notifications);
  });

  it('leaves other events alone', () => {
    const state = reduce(initialNotifications, { type: 'user.message', actor: 'user', threadId: 'main', payload: { text: 'hi' } }, { type: 'thread.failed', threadId: 't1', payload: { error: 'x' } });

    assert.equal(state, initialNotifications);
  });
});
