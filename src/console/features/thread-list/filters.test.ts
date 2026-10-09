import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hasFilters, withFilters } from './filters.ts';

describe('thread list filters', () => {
  it('patches the route and drops empty keys', () => {
    assert.deepEqual(withFilters({ key: 'threads', status: 'active', q: 'x' }, { q: '' }), { key: 'threads', status: 'active' });
    assert.deepEqual(withFilters({ key: 'threads' }, { agent: 'engineer', status: undefined }), { key: 'threads', agent: 'engineer' });
    assert.deepEqual(withFilters({ key: 'threads', project: 'p' }, { project: undefined }), { key: 'threads' });
  });

  it('knows a filtered route', () => {
    assert.equal(hasFilters({ key: 'threads' }), false);
    assert.equal(hasFilters({ key: 'threads', q: 'slug' }), true);
  });
});
