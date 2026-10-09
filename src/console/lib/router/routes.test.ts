import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { navKeyOf, readRoute, writeRoute } from './routes.ts';
import type { AppRoute } from './routes.ts';

const CASES: [string, AppRoute][] = [
  ['/', { key: 'home' }],
  ['/threads', { key: 'threads' }],
  ['/threads?status=active&agent=engineer&project=balabash&q=slug', { key: 'threads', status: 'active', agent: 'engineer', project: 'balabash', q: 'slug' }],
  ['/threads/4f1c-aa', { key: 'thread', id: '4f1c-aa' }],
  ['/projects', { key: 'projects' }],
  ['/projects?archived=1', { key: 'projects', archived: true }],
  ['/projects/balabash', { key: 'project', slug: 'balabash' }],
  ['/projects/balabash/files', { key: 'project', slug: 'balabash', path: '' }],
  ['/projects/balabash/files/console/plan.md', { key: 'project', slug: 'balabash', path: 'console/plan.md' }],
  ['/workspace', { key: 'files', path: '' }],
  ['/workspace/a%20b/c.md?view=edit', { key: 'files', path: 'a b/c.md', view: 'edit' }],
  ['/apps', { key: 'apps' }],
  ['/schedule', { key: 'schedule' }],
  ['/schedule/t1', { key: 'schedule', taskId: 't1' }],
  ['/connections', { key: 'connections' }],
  ['/secrets/abc', { key: 'secrets', id: 'abc' }],
  ['/agents', { key: 'agents' }],
  ['/agents/engineer', { key: 'agents', name: 'engineer' }],
  ['/system', { key: 'system' }],
  ['/settings', { key: 'settings' }],
  ['/dev/ui', { key: 'dev_ui' }],
  ['/dev/ui?section=Btn', { key: 'dev_ui', section: 'Btn' }],
];

describe('routes', () => {
  it('reads every URL into its route and writes it back', () => {
    for (const [url, route] of CASES) {
      assert.deepEqual(readRoute(url), route, url);
      assert.equal(writeRoute(route), url, JSON.stringify(route));
    }
  });

  it('ignores unknown filter values and trailing slashes', () => {
    assert.deepEqual(readRoute('/threads/?status=bogus'), { key: 'threads' });
    assert.deepEqual(readRoute('/threads/42/'), { key: 'thread', id: '42' });
  });

  it('catches everything else as not_found with the URL kept', () => {
    assert.deepEqual(readRoute('/nope/really?x=1'), { key: 'not_found', url: '/nope/really?x=1' });
    assert.deepEqual(readRoute('/threads/1/2'), { key: 'not_found', url: '/threads/1/2' });
    assert.deepEqual(readRoute('/projects/p/other'), { key: 'not_found', url: '/projects/p/other' });
    assert.equal(writeRoute({ key: 'not_found', url: '/nope' }), '/nope');
  });

  it('maps routes to the shell sections', () => {
    assert.equal(navKeyOf({ key: 'thread', id: '1' }), 'threads');
    assert.equal(navKeyOf({ key: 'project', slug: 's' }), 'projects');
    assert.equal(navKeyOf({ key: 'dev_ui' }), null);
    assert.equal(navKeyOf({ key: 'system' }), 'system');
  });
});
