import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { thread } from '../fixtures.ts';
import { inFilterSet, matchesFilters, sameFilters, threadMatches, threadsFiltersOf } from './filters.ts';

const projects = { byId: { p1: { id: 'p1', slug: 'balabash', title: 'Balabash', description: '', archived: false, createdAt: new Date(), updatedAt: new Date() } }, ids: ['p1'] };

describe('threads list filters', () => {
  const none = { status: null, projectId: null, agent: null, q: null, createdAtGte: null, createdAtLte: null };

  it('reads the route as the server’s filter set, the project by slug, the search trimmed', () => {
    assert.deepEqual(threadsFiltersOf({ key: 'threads' }, projects), none);
    assert.deepEqual(threadsFiltersOf({ key: 'threads', status: 'failed', project: 'balabash', agent: 'engineer', q: '  slug ' }, projects), { ...none, status: 'failed', projectId: 'p1', agent: 'engineer', q: 'slug' });
    assert.equal(threadsFiltersOf({ key: 'threads', project: 'unknown', q: '  ' }, projects).projectId, null);
    assert.equal(threadsFiltersOf({ key: 'threads', q: '  ' }, projects).q, null);
  });

  it('turns the days of the period into the instants of the query, both ends inclusive', () => {
    // Local days: the instants are the browser zone's, written as ISO.
    const filters = threadsFiltersOf({ key: 'threads', from: '2026-10-01', to: '2026-10-09' }, projects);

    assert.equal(filters.createdAtGte, new Date(2026, 9, 1).toISOString());
    assert.equal(filters.createdAtLte, new Date(new Date(2026, 9, 10).getTime() - 1).toISOString());
    assert.deepEqual(threadsFiltersOf({ key: 'threads', from: '2026-10-01' }, projects), { ...none, createdAtGte: new Date(2026, 9, 1).toISOString() });
    assert.deepEqual(threadsFiltersOf({ key: 'threads', to: '2026-10-09' }, projects), { ...none, createdAtLte: new Date(new Date(2026, 9, 10).getTime() - 1).toISOString() });
  });

  it('compares every field of the set', () => {
    const a = { ...none, agent: 'engineer' };

    assert.equal(sameFilters(a, { ...a }), true);
    assert.equal(sameFilters(a, { ...a, q: 'x' }), false);
    assert.equal(sameFilters(a, { ...a, agent: null }), false);
    assert.equal(sameFilters(a, { ...a, createdAtGte: '2026-10-01T00:00:00.000Z' }), false);
    assert.equal(sameFilters(a, { ...a, createdAtLte: '2026-10-09T23:59:59.999Z' }), false);
    assert.equal(sameFilters(a, null), false);
    assert.equal(sameFilters(null, null), true);
  });

  it('reads a thread by the same rules as the server, status aside for the set', () => {
    const t = thread({ id: 't', agent: 'designer', projectId: 'p1', status: 'completed', title: 'Public URL scheme', summary: { text: 'slug is unique' } });

    assert.equal(threadMatches(t, 'SLUG'), true);
    assert.equal(threadMatches(t, 'nothing'), false);
    assert.equal(inFilterSet(t, { ...none, status: 'active', projectId: 'p1', agent: 'designer', q: 'url' }), true);
    assert.equal(matchesFilters(t, { ...none, status: 'active', projectId: 'p1', agent: 'designer', q: 'url' }), false);
    assert.equal(matchesFilters(t, { ...none, status: 'completed' }), true);
    assert.equal(matchesFilters(t, { ...none, projectId: 'p2' }), false);
    assert.equal(matchesFilters(t, { ...none, agent: 'engineer' }), false);
  });

  it('reads the period as the server does: created_at within the instants, ends included', () => {
    const t = thread({ id: 't', createdAt: new Date('2026-10-09T12:00:00.000Z') });

    assert.equal(inFilterSet(t, { ...none, createdAtGte: '2026-10-09T12:00:00.000Z' }), true);
    assert.equal(inFilterSet(t, { ...none, createdAtGte: '2026-10-09T12:00:00.001Z' }), false);
    assert.equal(inFilterSet(t, { ...none, createdAtLte: '2026-10-09T12:00:00.000Z' }), true);
    assert.equal(inFilterSet(t, { ...none, createdAtLte: '2026-10-09T11:59:59.999Z' }), false);
    assert.equal(matchesFilters(t, { ...none, createdAtGte: '2026-10-01T00:00:00.000Z', createdAtLte: '2026-10-09T23:59:59.999Z' }), true);
    assert.equal(matchesFilters(t, { ...none, createdAtGte: '2026-10-10T00:00:00.000Z', createdAtLte: '2026-10-11T23:59:59.999Z' }), false);
  });
});
