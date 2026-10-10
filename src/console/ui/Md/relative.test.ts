import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isRelativeUrl, resolveRelative } from './relative.ts';

describe('markdown — relative references of a placed document', () => {
  it('tells a relative reference from a scheme, an absolute path and a fragment', () => {
    assert.equal(isRelativeUrl('notes.md'), true);
    assert.equal(isRelativeUrl('./notes.md'), true);
    assert.equal(isRelativeUrl('../design/README.md'), true);
    assert.equal(isRelativeUrl('design/'), true);
    assert.equal(isRelativeUrl('a/b:c.md'), true);
    assert.equal(isRelativeUrl('page?x=1:2'), true);
    assert.equal(isRelativeUrl('https://example.com/x'), false);
    assert.equal(isRelativeUrl('mailto:someone@example.com'), false);
    assert.equal(isRelativeUrl('C:/x.md'), false);
    assert.equal(isRelativeUrl('/files/a.png'), false);
    assert.equal(isRelativeUrl('//host/a.png'), false);
    assert.equal(isRelativeUrl('\\\\host\\a.png'), false);
    assert.equal(isRelativeUrl('\\x.md'), false);
    assert.equal(isRelativeUrl('#section'), false);
    assert.equal(isRelativeUrl(''), false);
  });

  it('resolves against the folder of the document', () => {
    assert.deepEqual(resolveRelative('balabash/console/README.md', 'frontend.md'), { path: 'balabash/console/frontend.md', hash: '' });
    assert.deepEqual(resolveRelative('balabash/console/README.md', './frontend.md'), { path: 'balabash/console/frontend.md', hash: '' });
    assert.deepEqual(resolveRelative('balabash/console/README.md', '../design/README.md'), { path: 'balabash/design/README.md', hash: '' });
    assert.deepEqual(resolveRelative('balabash/console/README.md', 'reviews/'), { path: 'balabash/console/reviews', hash: '' });
    assert.deepEqual(resolveRelative('balabash/console/README.md', '.'), { path: 'balabash/console', hash: '' });
    assert.deepEqual(resolveRelative('README.md', 'notes.md'), { path: 'notes.md', hash: '' });
  });

  it('keeps the fragment, drops the query and undoes the percent-encoding', () => {
    assert.deepEqual(resolveRelative('a/b.md', 'c.md#part-2'), { path: 'a/c.md', hash: '#part-2' });
    assert.deepEqual(resolveRelative('a/b.md', 'c.md?x=1'), { path: 'a/c.md', hash: '' });
    assert.deepEqual(resolveRelative('a/b.md', 'my%20file.md'), { path: 'a/my file.md', hash: '' });
    assert.deepEqual(resolveRelative('a/b.md', 'my file.md'), { path: 'a/my file.md', hash: '' });
    assert.deepEqual(resolveRelative('a/b.md', '%D0%B4%D0%BE%D0%BA.md'), { path: 'a/док.md', hash: '' });
  });

  it('keeps the special characters of the document’s own folder, and a query alone leads to the document', () => {
    assert.deepEqual(resolveRelative('proj/a#b/readme.md', 'next.md'), { path: 'proj/a#b/next.md', hash: '' });
    assert.deepEqual(resolveRelative('proj/a?b/readme.md', 'next.md'), { path: 'proj/a?b/next.md', hash: '' });
    assert.deepEqual(resolveRelative('proj/100%/readme.md', 'next.md'), { path: 'proj/100%/next.md', hash: '' });
    assert.deepEqual(resolveRelative('proj/%20/readme.md', 'next.md'), { path: 'proj/%20/next.md', hash: '' });
    assert.deepEqual(resolveRelative('proj/a b/c d.md', '../e.md'), { path: 'proj/e.md', hash: '' });
    assert.deepEqual(resolveRelative('proj/readme.md', '?x=1#part'), { path: 'proj/readme.md', hash: '#part' });
    assert.deepEqual(resolveRelative('proj/readme.md', '?x=1'), { path: 'proj/readme.md', hash: '' });
  });

  it('stops at the root of the file area', () => {
    assert.deepEqual(resolveRelative('a/b.md', '../../../x.md'), { path: 'x.md', hash: '' });
    assert.deepEqual(resolveRelative('a/b.md', '%2E%2E/%2e%2e/x.md'), { path: 'x.md', hash: '' });
    assert.deepEqual(resolveRelative('b.md', '..'), { path: '', hash: '' });
    assert.deepEqual(resolveRelative('a/b.md', 'x\\y.md'), { path: 'a/x/y.md', hash: '' });
  });

  it('resolves an encoded separator to nothing: a segment holding one is no path of the file area', () => {
    assert.equal(resolveRelative('proj/readme.md', '..%2Fother.md'), null);
    assert.equal(resolveRelative('proj/readme.md', '..%2F..%2F..%2Fx.png'), null);
    assert.equal(resolveRelative('proj/readme.md', 'a%2F..%2Fb.md'), null);
    assert.equal(resolveRelative('proj/readme.md', 'a%5C..%5C..%5Cx.md'), null);
    assert.equal(resolveRelative('proj/readme.md', '%2E%2E%2Fx.md'), null);
    assert.equal(resolveRelative('proj/readme.md', 'a//b.md'), null);
  });

  it('leaves what is not relative or cannot be a path', () => {
    assert.equal(resolveRelative('a/b.md', 'https://example.com/x.png'), null);
    assert.equal(resolveRelative('a/b.md', '/files/a/x.png'), null);
    assert.equal(resolveRelative('a/b.md', '#top'), null);
    assert.equal(resolveRelative('a/b.md', ''), null);
    assert.equal(resolveRelative('a/b.md', 'bad%zz.md'), null);
  });
});
