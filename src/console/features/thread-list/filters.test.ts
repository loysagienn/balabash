import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { hasFilters, withFilters } from './filters.ts';

describe('thread list filters', () => {
  it('patches the route and drops empty keys', () => {
    assert.deepEqual(withFilters({ key: 'threads', status: 'active', q: 'x' }, { q: '' }), { key: 'threads', status: 'active' });
    assert.deepEqual(withFilters({ key: 'threads' }, { agent: 'engineer', status: undefined }), { key: 'threads', agent: 'engineer' });
    assert.deepEqual(withFilters({ key: 'threads', project: 'p' }, { project: undefined }), { key: 'threads' });
    assert.deepEqual(withFilters({ key: 'threads', from: '2026-10-01', to: '2026-10-09' }, { from: '2026-10-09', to: undefined }), { key: 'threads', from: '2026-10-09' });
    assert.deepEqual(withFilters({ key: 'threads', from: '2026-10-01' }, { from: undefined }), { key: 'threads' });
  });

  it('knows a filtered route', () => {
    assert.equal(hasFilters({ key: 'threads' }), false);
    assert.equal(hasFilters({ key: 'threads', q: 'slug' }), true);
    assert.equal(hasFilters({ key: 'threads', from: '2026-10-01' }), true);
    assert.equal(hasFilters({ key: 'threads', to: '2026-10-09' }), true);
  });
});
