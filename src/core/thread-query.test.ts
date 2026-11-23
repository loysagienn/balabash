import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { escapeLike, threadsWhere } from './thread-query.ts';

describe('threads listing WHERE', () => {
  it('searches the title, the description and the summary text with the wildcards of the text escaped', () => {
    const where = threadsWhere('u1', { q: '50%_done\\' });

    assert.equal(where.sql, "threads.workspace_id = ? AND (threads.title ILIKE ? OR threads.description ILIKE ? OR threads.summary->>'text' ILIKE ?)");
    assert.deepEqual(where.values, ['u1', '%50\\%\\_done\\\\%', '%50\\%\\_done\\\\%', '%50\\%\\_done\\\\%']);
    assert.equal(escapeLike('plain'), 'plain');
    // An empty search is no filter.
    assert.equal(threadsWhere('u1', { q: '' }).sql, 'threads.workspace_id = ?');
  });
});
