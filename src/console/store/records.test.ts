import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { connectionFromRecord, projectFromRecord, taskFromRecord } from './records.ts';

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
});
