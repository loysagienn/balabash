import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { nested, parentRoute, samePage } from './nesting.ts';

describe('router — nesting', () => {
  it('names the parent of every nested page and none for a top-level screen', () => {
    assert.deepEqual(parentRoute({ key: 'thread', id: 't1' }), { key: 'threads' });
    assert.deepEqual(parentRoute({ key: 'project', slug: 'p' }), { key: 'projects' });
    assert.deepEqual(parentRoute({ key: 'project', slug: 'p', path: '' }), { key: 'projects' });
    assert.deepEqual(parentRoute({ key: 'project', slug: 'p', path: 'docs' }), { key: 'project', slug: 'p' });
    assert.deepEqual(parentRoute({ key: 'project', slug: 'p', path: 'docs/a.md', view: 'edit' }), {
      key: 'project',
      slug: 'p',
      path: 'docs',
    });
    assert.deepEqual(parentRoute({ key: 'files', path: 'a' }), { key: 'files', path: '' });
    assert.deepEqual(parentRoute({ key: 'files', path: 'a/b/c.md' }), { key: 'files', path: 'a/b' });
    assert.deepEqual(parentRoute({ key: 'schedule', slug: 'daily', q: 'da' }), { key: 'schedule', q: 'da' });
    assert.deepEqual(parentRoute({ key: 'schedule', new: true, q: 'x' }), { key: 'schedule', q: 'x' });
    assert.deepEqual(parentRoute({ key: 'agents', name: 'engineer', q: 'en' }), { key: 'agents', q: 'en' });

    for (const route of [
      { key: 'home' },
      { key: 'threads', status: 'active' },
      { key: 'projects' },
      { key: 'files', path: '' },
      { key: 'schedule' },
      { key: 'schedule', tab: 'log', task: 'daily' },
      { key: 'agents', q: 'x' },
      { key: 'apps' },
      { key: 'connections' },
      { key: 'system' },
      { key: 'settings' },
      { key: 'secrets', id: 's' },
      { key: 'dev_ui' },
      { key: 'login' },
      { key: 'not_found', url: '/x' },
    ] as const) {
      assert.equal(parentRoute(route), null, route.key);
      assert.equal(nested(route), false, route.key);
    }

    assert.equal(nested({ key: 'thread', id: 't1' }), true);
    assert.equal(nested({ key: 'files', path: 'a' }), true);
  });

  it('keeps the page while moving inside a project', () => {
    assert.equal(samePage({ key: 'project', slug: 'p' }, { key: 'project', slug: 'p', path: 'docs' }), true);
    assert.equal(samePage({ key: 'project', slug: 'p', path: 'docs/a.md' }, { key: 'project', slug: 'p' }), true);
    assert.equal(samePage({ key: 'project', slug: 'p', path: 'a' }, { key: 'project', slug: 'p', path: 'b' }), true);
    assert.equal(samePage({ key: 'project', slug: 'p' }, { key: 'project', slug: 'q' }), false);
    assert.equal(samePage({ key: 'projects' }, { key: 'project', slug: 'p' }), false);
    assert.equal(samePage({ key: 'project', slug: 'p', path: 'a' }, { key: 'projects' }), false);
    assert.equal(samePage({ key: 'files', path: '' }, { key: 'files', path: 'a' }), false);
  });
});
