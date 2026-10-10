import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { connectionFromRecord, projectFromRecord, secretRequestFromRecord, taskFromRecord } from './records.ts';

describe('registry records → views', () => {
  it('parses a project record and skips one without id or dates', () => {
    const view = projectFromRecord({ id: 'p1', title: 'Balabash', slug: 'balabash', description: 'd', archived: false, createdAt: '2026-10-09T10:00:00.000Z', updatedAt: '2026-10-09T11:00:00.000Z' });

    assert.equal(view?.updatedAt.toISOString(), '2026-10-09T11:00:00.000Z');
    assert.equal(view?.createdAt.toISOString(), '2026-10-09T10:00:00.000Z');
    assert.equal(view?.archivedAt, null, 'a record written before the date was kept has none');
    assert.equal(projectFromRecord({ id: 'p1', archived: true, archivedAt: '2026-10-09T12:00:00.000Z', createdAt: '2026-10-09T10:00:00.000Z', updatedAt: '2026-10-09T12:00:00.000Z' })?.archivedAt?.toISOString(), '2026-10-09T12:00:00.000Z');
    assert.equal(projectFromRecord({ id: 'p1', archived: true, archivedAt: 'nope', createdAt: '2026-10-09T10:00:00.000Z', updatedAt: '2026-10-09T12:00:00.000Z' })?.archivedAt, null);
    assert.equal(projectFromRecord({ title: 'x' }), null);
    assert.equal(projectFromRecord({ id: 'p', createdAt: 'nope', updatedAt: '2026-10-09T11:00:00.000Z' }), null);
  });

  it('parses a task record with its optional fields', () => {
    const view = taskFromRecord({ id: 'k1', slug: 'backup', name: 'Backup', description: null, kind: 'command', cron: '0 3 * * *', at: null, note: null, command: 'pg_dump', cwd: null, timeoutMs: 1000, reportOnSuccess: true, createdBy: 'scheduler', createdAt: '2026-10-09T10:00:00.000Z', nextRunAt: '2026-10-10T03:00:00.000Z' });

    assert.equal(view?.nextRunAt?.toISOString(), '2026-10-10T03:00:00.000Z');
    assert.equal(view?.at, null);
    assert.equal(view?.timeoutMs, 1000);
    assert.equal(taskFromRecord({ id: 'k', createdAt: '2026-10-09T10:00:00.000Z' }), null);
  });

  it('parses a connection record under the names of the connection.* family', () => {
    const view = connectionFromRecord({ connectionId: 'c1', server: 'notion', account: 'default', name: 'Notion', status: 'pending', identity: null, scope: null, threadId: 't1', createdAt: '2026-10-09T10:00:00.000Z', updatedAt: '2026-10-09T10:00:00.000Z' });

    assert.equal(view?.id, 'c1');
    assert.equal(view?.accountKey, 'default');
    assert.equal(view?.displayName, 'Notion');
    assert.equal(connectionFromRecord({ server: 'notion', account: 'default', name: 'Notion' }), null);
  });

  it('parses an open request for credentials: the kind from the caller, the author from the event, the moment from the record or the event', () => {
    const author = { threadId: 'auth-1', agentName: 'auth', createdAt: new Date('2026-10-10T10:00:01.000Z') };
    const view = secretRequestFromRecord('external-secrets', { requestId: 'r1', server: 'yandex-direct', fields: ['API_KEY', 7 as unknown as string], requestedAt: '2026-10-10T10:00:00.000Z' }, author);

    assert.deepEqual(view, { id: 'r1', kind: 'external-secrets', server: 'yandex-direct', fields: ['API_KEY'], threadId: 'auth-1', agent: 'auth', requestedAt: new Date('2026-10-10T10:00:00.000Z') });
    assert.equal(secretRequestFromRecord('oauth-client', { requestId: 'r2', server: 'google' }, author)?.requestedAt.toISOString(), '2026-10-10T10:00:01.000Z');
    assert.deepEqual(secretRequestFromRecord('oauth-client', { requestId: 'r2', server: 'google' }, author)?.fields, []);
    assert.equal(secretRequestFromRecord('oauth-client', { server: 'google' }, author), null);
    assert.equal(secretRequestFromRecord('oauth-client', { requestId: 'r2' }, author), null);
  });
});
