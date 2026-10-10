import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fromOldWeb, localPath, navKeyOf, readRoute, writeRoute } from './routes.ts';
import type { AppRoute } from './routes.ts';

const CASES: [string, AppRoute][] = [
  ['/', { key: 'home' }],
  ['/threads', { key: 'threads' }],
  ['/threads?status=active&agent=engineer&project=balabash&q=slug', { key: 'threads', status: 'active', agent: 'engineer', project: 'balabash', q: 'slug' }],
  ['/threads/4f1c-aa', { key: 'thread', id: '4f1c-aa' }],
  ['/projects', { key: 'projects' }],
  ['/projects?archived=1', { key: 'projects', archived: true }],
  ['/projects?archived=1&q=blog', { key: 'projects', archived: true, q: 'blog' }],
  ['/projects?q=reno', { key: 'projects', q: 'reno' }],
  ['/projects/balabash', { key: 'project', slug: 'balabash' }],
  ['/projects/balabash/files', { key: 'project', slug: 'balabash', path: '' }],
  ['/projects/balabash/files/console/plan.md', { key: 'project', slug: 'balabash', path: 'console/plan.md' }],
  ['/workspace', { key: 'files', path: '' }],
  ['/workspace/a%20b/c.md?view=edit', { key: 'files', path: 'a b/c.md', view: 'edit' }],
  ['/apps', { key: 'apps' }],
  ['/apps?filter=errors&q=wind', { key: 'apps', filter: 'errors', q: 'wind' }],
  ['/schedule', { key: 'schedule' }],
  ['/schedule/t1', { key: 'schedule', taskId: 't1' }],
  ['/connections', { key: 'connections' }],
  ['/secrets/abc', { key: 'secrets', id: 'abc' }],
  ['/agents', { key: 'agents' }],
  ['/agents/engineer', { key: 'agents', name: 'engineer' }],
  ['/agents/engineer?q=en', { key: 'agents', name: 'engineer', q: 'en' }],
  ['/system', { key: 'system' }],
  ['/settings', { key: 'settings' }],
  ['/dev/ui', { key: 'dev_ui' }],
  ['/dev/ui?section=Btn', { key: 'dev_ui', section: 'Btn' }],
  ['/login', { key: 'login' }],
  ['/login?next=%2Fapps%2Fnotes%3Ftab%3D1', { key: 'login', next: '/apps/notes?tab=1' }],
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
    assert.deepEqual(readRoute('/apps?filter=bogus'), { key: 'apps' });
    assert.deepEqual(readRoute('/threads/42/'), { key: 'thread', id: '42' });
  });

  it('keeps only a path of this host as the sign-in destination, in the form the browser navigates by', () => {
    assert.equal(localPath('/threads/1'), '/threads/1');
    assert.equal(localPath('/'), '/');
    assert.equal(localPath('/apps/notes?tab=1#top'), '/apps/notes?tab=1#top');
    assert.equal(localPath('/workspace/a b/заметки.md'), '/workspace/a%20b/%D0%B7%D0%B0%D0%BC%D0%B5%D1%82%D0%BA%D0%B8.md');
    assert.equal(localPath('/./threads/../projects'), '/projects');
    assert.equal(localPath('/%2F%2Fevil.example'), '/%2F%2Fevil.example');
    assert.equal(localPath('//evil.example/x'), null);
    assert.equal(localPath('/\\evil.example/x'), null);
    assert.equal(localPath('https://evil.example/'), null);
    assert.equal(localPath('threads'), null);
    assert.equal(localPath(''), null);
    assert.equal(localPath('/\t/evil.example/x'), null);
    assert.equal(localPath('/\n/evil.example/x'), null);
    assert.equal(localPath('/\r/evil.example/x'), null);
    assert.equal(localPath('/\t\\evil.example/x'), null);
    assert.equal(localPath('/\n\\evil.example/x'), null);
    assert.equal(localPath('/\r\\evil.example/x'), null);
    assert.equal(localPath('/\\\\evil.example/x'), null);
    assert.equal(localPath('/\t\t//evil.example'), null);
    assert.deepEqual(readRoute('/login?next=%2F%2Fevil.example'), { key: 'login' });
    assert.deepEqual(readRoute('/login?next=%2F%09%2Fevil.example%2Fx'), { key: 'login' });
    assert.deepEqual(readRoute('/login?next=%2F%0A%5Cevil.example%2Fx'), { key: 'login' });
    assert.deepEqual(readRoute('/login?next=threads'), { key: 'login' });
    assert.deepEqual(readRoute('/login?next=%2F.%2Fthreads%3Fstatus%3Dactive'), { key: 'login', next: '/threads?status=active' });
  });

  it('reads the addresses of the old web as the console routes they became', () => {
    assert.deepEqual(readRoute('/thread/4f1c-aa'), { key: 'thread', id: '4f1c-aa' });
    assert.deepEqual(readRoute('/thread/4f1c-aa/'), { key: 'thread', id: '4f1c-aa' });
    assert.deepEqual(readRoute('/applications'), { key: 'apps' });
    assert.deepEqual(readRoute('/applications?x=1'), { key: 'apps' });
    assert.deepEqual(readRoute('/llm-usage'), { key: 'system' });
    assert.equal(fromOldWeb('/thread/1?x=1'), '/threads/1?x=1');
    assert.equal(fromOldWeb('/threads/1'), '/threads/1');
    assert.equal(fromOldWeb('/thread'), '/threads');
    assert.equal(fromOldWeb('/threading/1'), '/threading/1');
    assert.equal(fromOldWeb('/thread-x'), '/thread-x');
    assert.deepEqual(readRoute('/thread'), { key: 'threads' });
    assert.deepEqual(readRoute('/thread/1/2'), { key: 'not_found', url: '/threads/1/2' });
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
