import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { escapeLike, threadsWhere } from './thread-query.ts';

describe('threads listing WHERE', () => {
  it('starts from the workspace and adds one condition per filter', () => {
    const where = threadsWhere('u1', {});

    assert.equal(where.sql, 'user_id = ?');
    assert.deepEqual(where.values, ['u1']);

    const full = threadsWhere('u1', { status: 'active', parentId: 'main', projectId: 'p1', agent: 'engineer', createdAtGte: new Date(1), createdAtLte: new Date(2), beforeCreatedSeq: 50n });

    assert.equal(
      full.sql,
      'user_id = ? AND status = ? AND parent_id = ? AND project_id = ? AND agent = ? AND created_at >= ? AND created_at <= ? AND created_seq < ?',
    );
    assert.deepEqual(full.values, ['u1', 'active', 'main', 'p1', 'engineer', new Date(1), new Date(2), 50n]);
  });

  it('selects root threads for a null parent', () => {
    assert.equal(threadsWhere('u1', { parentId: null }).sql, 'user_id = ? AND parent_id IS NULL');
  });

  it('searches the title, the description and the summary text with the wildcards of the text escaped', () => {
    const where = threadsWhere('u1', { q: '50%_done\\' });

    assert.equal(where.sql, "user_id = ? AND (title ILIKE ? OR description ILIKE ? OR summary->>'text' ILIKE ?)");
    assert.deepEqual(where.values, ['u1', '%50\\%\\_done\\\\%', '%50\\%\\_done\\\\%', '%50\\%\\_done\\\\%']);
    assert.equal(escapeLike('plain'), 'plain');
    // An empty search is no filter.
    assert.equal(threadsWhere('u1', { q: '' }).sql, 'user_id = ?');
  });
});
