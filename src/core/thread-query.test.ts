import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { escapeLike, threadsWhere } from './thread-query.ts';

describe('threads listing WHERE', () => {
  it('starts from the workspace and adds one condition per filter', () => {
    const where = threadsWhere('u1', {});

    assert.equal(where.sql, 'threads.user_id = ?');
    assert.deepEqual(where.values, ['u1']);

    const full = threadsWhere('u1', { status: 'active', parentId: 'main', projectId: 'p1', agent: 'engineer', createdAtGte: new Date(1), createdAtLte: new Date(2), beforeCreatedSeq: 50n });

    assert.equal(
      full.sql,
      'threads.user_id = ? AND threads.status = ? AND threads.parent_id = ? AND threads.project_id = ? AND threads.agent = ? AND threads.created_at >= ? AND threads.created_at <= ? AND threads.created_seq < ?',
    );
    assert.deepEqual(full.values, ['u1', 'active', 'main', 'p1', 'engineer', new Date(1), new Date(2), 50n]);
  });

  it('selects root threads for a null parent', () => {
    assert.equal(threadsWhere('u1', { parentId: null }).sql, 'threads.user_id = ? AND threads.parent_id IS NULL');
  });

  it('searches the title, the description and the summary text with the wildcards of the text escaped', () => {
    const where = threadsWhere('u1', { q: '50%_done\\' });

    assert.equal(where.sql, "threads.user_id = ? AND (threads.title ILIKE ? OR threads.description ILIKE ? OR threads.summary->>'text' ILIKE ?)");
    assert.deepEqual(where.values, ['u1', '%50\\%\\_done\\\\%', '%50\\%\\_done\\\\%', '%50\\%\\_done\\\\%']);
    assert.equal(escapeLike('plain'), 'plain');
    // An empty search is no filter.
    assert.equal(threadsWhere('u1', { q: '' }).sql, 'threads.user_id = ?');
  });
});
