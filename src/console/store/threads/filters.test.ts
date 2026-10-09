import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { thread } from '../fixtures.ts';
import { inFilterSet, matchesFilters, sameFilters, threadMatches, threadsFiltersOf } from './filters.ts';

const projects = { byId: { p1: { id: 'p1', slug: 'balabash', title: 'Balabash', description: '', archived: false, createdAt: new Date(), updatedAt: new Date() } }, ids: ['p1'] };

describe('threads list filters', () => {
  it('reads the route as the server’s filter set, the project by slug, the search trimmed', () => {
    assert.deepEqual(threadsFiltersOf({ key: 'threads' }, projects), { status: null, projectId: null, agent: null, q: null });
    assert.deepEqual(threadsFiltersOf({ key: 'threads', status: 'failed', project: 'balabash', agent: 'engineer', q: '  slug ' }, projects), { status: 'failed', projectId: 'p1', agent: 'engineer', q: 'slug' });
    assert.equal(threadsFiltersOf({ key: 'threads', project: 'unknown', q: '  ' }, projects).projectId, null);
    assert.equal(threadsFiltersOf({ key: 'threads', q: '  ' }, projects).q, null);
  });

  it('compares every field of the set', () => {
    const a = { status: null, projectId: null, agent: 'engineer', q: null };

    assert.equal(sameFilters(a, { ...a }), true);
    assert.equal(sameFilters(a, { ...a, q: 'x' }), false);
    assert.equal(sameFilters(a, { ...a, agent: null }), false);
    assert.equal(sameFilters(a, null), false);
    assert.equal(sameFilters(null, null), true);
  });

  it('reads a thread by the same rules as the server, status aside for the set', () => {
    const t = thread({ id: 't', agent: 'designer', projectId: 'p1', status: 'completed', title: 'Public URL scheme', summary: { text: 'slug is unique' } });

    assert.equal(threadMatches(t, 'SLUG'), true);
    assert.equal(threadMatches(t, 'nothing'), false);
    assert.equal(inFilterSet(t, { status: 'active', projectId: 'p1', agent: 'designer', q: 'url' }), true);
    assert.equal(matchesFilters(t, { status: 'active', projectId: 'p1', agent: 'designer', q: 'url' }), false);
    assert.equal(matchesFilters(t, { status: 'completed', projectId: null, agent: null, q: null }), true);
    assert.equal(matchesFilters(t, { status: null, projectId: 'p2', agent: null, q: null }), false);
    assert.equal(matchesFilters(t, { status: null, projectId: null, agent: 'engineer', q: null }), false);
  });
});
