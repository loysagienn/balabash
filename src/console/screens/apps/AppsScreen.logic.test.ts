import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { appInFilter, appMatches, appsCounts, hasAppsFilters, visibleApps, withAppsFilters } from './AppsScreen.logic.ts';

const APPS = [
  { name: 'Calorie tracker', description: 'Food diary', path: 'apps/kcal', slug: 'kcal', manifestError: null },
  { name: 'Renovation checklist', description: null, path: 'renovation/app', slug: null, manifestError: null },
  { name: null, description: null, path: 'apps/wind', slug: 'wind', manifestError: 'endpoints.forecast: unknown parameter' },
];

describe('apps screen rules', () => {
  it('counts the segments', () => {
    assert.deepEqual(appsCounts(APPS), { all: 3, published: 2, errors: 1 });
    assert.deepEqual(appsCounts([]), { all: 0, published: 0, errors: 0 });
  });

  it('matches the search against the name, the description and the folder', () => {
    assert.equal(appMatches(APPS[0], undefined), true);
    assert.equal(appMatches(APPS[0], ' '), true);
    assert.equal(appMatches(APPS[0], 'CALORIE'), true);
    assert.equal(appMatches(APPS[0], 'diary'), true);
    assert.equal(appMatches(APPS[0], 'apps/k'), true);
    assert.equal(appMatches(APPS[2], 'wind'), true);
    assert.equal(appMatches(APPS[1], 'kcal'), false);
  });

  it('filters by publication and by manifest errors', () => {
    assert.equal(appInFilter(APPS[0], undefined), true);
    assert.equal(appInFilter(APPS[0], 'published'), true);
    assert.equal(appInFilter(APPS[1], 'published'), false);
    assert.equal(appInFilter(APPS[2], 'errors'), true);
    assert.equal(appInFilter(APPS[0], 'errors'), false);
    assert.deepEqual(visibleApps(APPS, { key: 'apps', filter: 'published', q: 'wi' }).map(app => app.path), ['apps/wind']);
    assert.deepEqual(visibleApps(APPS, { key: 'apps' }).length, 3);
  });

  it('writes the next route of a filter change without empty keys', () => {
    assert.deepEqual(withAppsFilters({ key: 'apps', filter: 'errors', q: 'x' }, { q: '' }), { key: 'apps', filter: 'errors' });
    assert.deepEqual(withAppsFilters({ key: 'apps', q: 'x' }, { filter: 'published' }), { key: 'apps', filter: 'published', q: 'x' });
    assert.deepEqual(withAppsFilters({ key: 'apps', filter: 'errors' }, { filter: undefined }), { key: 'apps' });
    assert.equal(hasAppsFilters({ key: 'apps' }), false);
    assert.equal(hasAppsFilters({ key: 'apps', q: 'x' }), true);
  });
});
