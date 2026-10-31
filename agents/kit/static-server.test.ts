import { test, describe, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { contentTypeFor, resolveRequestPath, startStaticServer } from './static-server.ts';
import type { StaticServer } from './static-server.ts';

describe('resolveRequestPath', () => {
  const root = '/srv/root';

  test('maps a request path onto the root, decoding percent escapes', () => {
    assert.equal(resolveRequestPath(root, '/a/b.html'), '/srv/root/a/b.html');
    assert.equal(resolveRequestPath(root, '/App%20Shell.dc.html?x=1#frag'), '/srv/root/App Shell.dc.html');
    assert.equal(resolveRequestPath(root, '/'), '/srv/root');
  });

  test('a path that leaves the root is nothing', () => {
    assert.equal(resolveRequestPath(root, '/../etc/passwd'), null);
    assert.equal(resolveRequestPath(root, '/a/../../etc/passwd'), null);
    assert.equal(resolveRequestPath(root, '/%2e%2e/%2e%2e/etc/passwd'), null);
    assert.equal(resolveRequestPath(root, '/a%00.html'), null);
    assert.equal(resolveRequestPath(root, '/%zz'), null);
  });

  test('a sibling of the root that shares its prefix is outside', () => {
    assert.equal(resolveRequestPath('/srv/root', '/../root2/x'), null);
  });
});

describe('contentTypeFor', () => {
  test('knows the files of a design and defaults to bytes', () => {
    assert.equal(contentTypeFor('x/Btn.dc.html'), 'text/html; charset=utf-8');
    assert.equal(contentTypeFor('tokens.css'), 'text/css; charset=utf-8');
    assert.equal(contentTypeFor('support.js'), 'text/javascript; charset=utf-8');
    assert.equal(contentTypeFor('canvas.json'), 'application/json; charset=utf-8');
    assert.equal(contentTypeFor('index.d.ts'), 'text/plain; charset=utf-8');
    assert.equal(contentTypeFor('icon.PNG'), 'image/png');
    assert.equal(contentTypeFor('font.woff2'), 'font/woff2');
    assert.equal(contentTypeFor('blob'), 'application/octet-stream');
  });
});

describe('startStaticServer', () => {
  let root: string;
  let server: StaticServer;

  before(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'static-server-'));
    await mkdir(path.join(root, 'design', 'sub dir'), { recursive: true });
    await writeFile(path.join(root, 'design', 'page.html'), '<!doctype html><p>hi</p>');
    await writeFile(path.join(root, 'design', 'style.css'), 'p{color:red}');
    await writeFile(path.join(root, 'design', 'sub dir', 'index.html'), '<p>index</p>');
    await writeFile(path.join(root, 'secret.txt'), 'inside root, served');
    server = await startStaticServer({ root });
  });

  after(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true });
  });

  test('listens on the loopback at a port of its own', () => {
    assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  });

  test('serves a file with its content type and no-store', async () => {
    const res = await fetch(`${server.url}/design/page.html`);

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal(await res.text(), '<!doctype html><p>hi</p>');

    const css = await fetch(`${server.url}/design/style.css`);

    assert.equal(css.headers.get('content-type'), 'text/css; charset=utf-8');
    assert.equal(await css.text(), 'p{color:red}');
  });

  test('a directory answers with its index.html; a percent-encoded name resolves', async () => {
    const res = await fetch(`${server.url}/design/sub%20dir/`);

    assert.equal(res.status, 200);
    assert.equal(await res.text(), '<p>index</p>');
  });

  test('HEAD carries the headers and no body', async () => {
    const res = await fetch(`${server.url}/design/page.html`, { method: 'HEAD' });

    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-length'), String(Buffer.byteLength('<!doctype html><p>hi</p>')));
    assert.equal(await res.text(), '');
  });

  test('missing files, directories without an index and paths outside the root are 404', async () => {
    assert.equal((await fetch(`${server.url}/design/nope.html`)).status, 404);
    assert.equal((await fetch(`${server.url}/design/`)).status, 404);
    // fetch normalizes a literal `..`; the encoded form reaches the server as is.
    assert.equal((await fetch(`${server.url}/%2e%2e/%2e%2e/etc/passwd`)).status, 404);
  });

  test('only GET and HEAD', async () => {
    assert.equal((await fetch(`${server.url}/design/page.html`, { method: 'POST', body: 'x' })).status, 405);
  });

  test('close frees the port', async () => {
    const extra = await startStaticServer({ root });

    assert.equal((await fetch(`${extra.url}/secret.txt`)).status, 200);
    await extra.close();
    await assert.rejects(fetch(`${extra.url}/secret.txt`));
  });
});
