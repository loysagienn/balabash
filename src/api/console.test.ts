// The console host branch (console.ts): host gating, the pass-through of
// the shared surfaces (/api, /files, /connect, /oauth, /apps/<path>),
// immutable assets, the no-store shell from the manifest and its absence,
// method and path refusals. A real Koa listener on an ephemeral
// port over a scratch dist/console — nothing of the live app is touched.
//
// Run: npm test  (node:test, native type stripping — no build needed).

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import Koa from 'koa';
import { createConsoleMiddleware } from './console.ts';

const CONSOLE_HOST = 'console.test';

let root: string;
let server: ReturnType<Koa['listen']>;
let port: number;

type Reply = { status: number; headers: http.IncomingHttpHeaders; text: () => Promise<string> };

// node:http rather than fetch: fetch silently drops a caller-set Host
// header, and the Host is the whole point here.
function request(urlPath: string, init: { host?: string; method?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: urlPath, method: init.method ?? 'GET', headers: { host: init.host ?? CONSOLE_HOST } },
      res => {
        const chunks: Buffer[] = [];

        res.on('data', chunk => chunks.push(chunk as Buffer));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text: async () => Buffer.concat(chunks).toString('utf8'),
          }),
        );
        res.on('error', reject);
      },
    );

    req.on('error', reject);
    req.end();
  });
}

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'balabash-console-test-'));
  await fs.mkdir(path.join(root, 'assets'), { recursive: true });
  await fs.writeFile(path.join(root, 'assets', 'main-ABC123.js'), 'console.log("hi")');
  await fs.writeFile(path.join(root, 'assets', 'main-DEF456.css'), 'body{}');
  await fs.mkdir(path.join(root, 'public'), { recursive: true });
  await fs.writeFile(path.join(root, 'public', 'manifest.webmanifest'), '{"name":"Balabash"}');
  await fs.writeFile(path.join(root, 'public', 'icon-192.png'), Buffer.from('89504e47', 'hex'));

  process.env.CONSOLE_DOMAIN = CONSOLE_HOST;

  const app = new Koa();

  app.use(createConsoleMiddleware(root));
  app.use(ctx => {
    ctx.status = 200;
    ctx.body = `fell through: ${ctx.method} ${ctx.path}`;
  });

  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', () => resolve()));
  port = (server.address() as AddressInfo).port;
});

after(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  await fs.rm(root, { recursive: true, force: true });
});

describe('console host branch', () => {
  test('other hosts are untouched', async () => {
    const response = await request('/anything', { host: 'balabash.example.com' });

    assert.equal(await response.text(), 'fell through: GET /anything');
  });

  test('/api and /files pass through on the console host', async () => {
    assert.equal(await (await request('/api/me')).text(), 'fell through: GET /api/me');
    assert.equal(await (await request('/api', { method: 'POST' })).text(), 'fell through: POST /api');
    assert.equal(await (await request('/files/x/y')).text(), 'fell through: GET /files/x/y');
    // Only the exact prefixes: /apix is the SPA's business.
    assert.equal((await request('/apix')).status, 503);
  });

  test('the connection surfaces pass through: /connect/<server> and /oauth/callback, whatever the method', async () => {
    assert.equal(await (await request('/connect/notion?nonce=abc')).text(), 'fell through: GET /connect/notion');
    assert.equal(await (await request('/connect')).text(), 'fell through: GET /connect');
    assert.equal(await (await request('/oauth/callback?code=1&state=2')).text(), 'fell through: GET /oauth/callback');
    assert.equal(await (await request('/oauth')).text(), 'fell through: GET /oauth');
    // The main chain answers a wrong method itself; the SPA's 405 is not its business.
    assert.equal(await (await request('/oauth/callback', { method: 'POST' })).text(), 'fell through: POST /oauth/callback');
    // Names that merely start alike are the SPA's.
    assert.equal((await request('/connected')).status, 503);
    assert.equal((await request('/oauth2')).status, 503);
  });

  test('the owner page of an app passes through, the Apps screen does not', async () => {
    assert.equal(await (await request('/apps/tracker')).text(), 'fell through: GET /apps/tracker');
    assert.equal(await (await request('/apps/tools/tracker/page?x=1')).text(), 'fell through: GET /apps/tools/tracker/page');
    assert.equal(await (await request('/apps/tracker', { method: 'HEAD' })).status, 200);
    // The bare section — with or without its trailing slash, with its own query — is the SPA's shell.
    assert.equal((await request('/apps')).status, 503);
    assert.equal((await request('/apps/')).status, 503);
    assert.equal((await request('/apps?filter=published')).status, 503);
    assert.equal((await request('/appsx')).status, 503);
  });

  test('without a manifest the shell answers 503 "not built"', async () => {
    const response = await request('/');

    assert.equal(response.status, 503);
    assert.match(response.headers['content-type'] ?? '', /text\/html/);
    assert.match(await response.text(), /not built/i);
  });

  test('with a manifest every navigation path answers the no-store shell', async () => {
    await fs.writeFile(
      path.join(root, 'manifest.json'),
      JSON.stringify({ builtAt: '2026-10-08T00:00:00.000Z', js: 'main-ABC123.js', css: 'main-DEF456.css' }),
    );

    for (const urlPath of ['/', '/threads/42', '/files-of-mine?x=1']) {
      const response = await request(urlPath);
      const html = await response.text();

      assert.equal(response.status, 200, urlPath);
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.match(html, /<script type="module" src="\/assets\/main-ABC123\.js"><\/script>/);
      assert.match(html, /<link rel="stylesheet" href="\/assets\/main-DEF456\.css">/);
      assert.match(html, /<meta name="console-build" content="2026-10-08T00:00:00\.000Z">/);
    }
  });

  test('the shell forbids the phone zoom and names the web app manifest and icons', async () => {
    const html = await (await request('/')).text();

    // The phone's pinch is off; the desktop ignores a viewport meta altogether.
    assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">/);
    assert.match(html, /<link rel="manifest" href="\/static\/manifest\.webmanifest">/);
    assert.match(html, /<link rel="apple-touch-icon" href="\/static\/apple-touch-icon\.png">/);
    assert.match(html, /<link rel="icon" type="image\/png" sizes="32x32" href="\/static\/favicon-32\.png">/);
    assert.match(html, /<link rel="icon" type="image\/png" sizes="192x192" href="\/static\/favicon-192\.png">/);
    assert.match(html, /<meta name="theme-color" content="#0c0d0f">/);
    assert.match(html, /<meta name="mobile-web-app-capable" content="yes">/);
    assert.match(html, /<meta name="apple-mobile-web-app-capable" content="yes">/);
    assert.match(html, /<meta name="apple-mobile-web-app-title" content="Balabash">/);
  });

  test('public files are served under /static by name with a short cache; unknown and walking names are 404', async () => {
    const manifest = await request('/static/manifest.webmanifest');

    assert.equal(manifest.status, 200);
    assert.match(manifest.headers['content-type'] ?? '', /application\/manifest\+json/);
    assert.equal(manifest.headers['cache-control'], 'public, max-age=3600');
    assert.equal(await manifest.text(), '{"name":"Balabash"}');

    const icon = await request('/static/icon-192.png', { method: 'HEAD' });

    assert.equal(icon.status, 200);
    assert.match(icon.headers['content-type'] ?? '', /image\/png/);
    assert.equal(icon.headers['content-length'], '4');

    assert.equal((await request('/static/missing.png')).status, 404);
    assert.equal((await request('/static/..%2Fmanifest.json')).status, 404);
    // The public directory is not the assets directory and vice versa.
    assert.equal((await request('/static/main-ABC123.js')).status, 404);
    assert.equal((await request('/assets/manifest.webmanifest')).status, 404);
    // A navigation to /static itself is still the SPA's (the shell).
    assert.equal((await request('/static')).status, 200);
  });

  test('a new manifest is picked up without a restart', async () => {
    // A distinct mtime: the cache is keyed on it.
    await new Promise(resolve => setTimeout(resolve, 20));
    await fs.writeFile(
      path.join(root, 'manifest.json'),
      JSON.stringify({ builtAt: '2026-10-09T00:00:00.000Z', js: 'main-NEW000.js', css: null }),
    );

    const html = await (await request('/')).text();

    assert.match(html, /main-NEW000\.js/);
    assert.doesNotMatch(html, /stylesheet/);
  });

  test('assets are served immutable with their type; unknown and walking names are 404', async () => {
    const js = await request('/assets/main-ABC123.js');

    assert.equal(js.status, 200);
    assert.match(js.headers['content-type'] ?? '', /text\/javascript/);
    assert.equal(js.headers['cache-control'], 'public, max-age=31536000, immutable');
    assert.equal(await js.text(), 'console.log("hi")');

    const head = await request('/assets/main-DEF456.css', { method: 'HEAD' });

    assert.equal(head.status, 200);
    assert.equal(head.headers['content-length'], '6');

    assert.equal((await request('/assets/missing.js')).status, 404);
    assert.equal((await request('/assets/..%2Fmanifest.json')).status, 404);
    assert.equal((await request('/assets/.hidden')).status, 404);
  });

  test('non-GET on SPA paths is 405', async () => {
    const response = await request('/threads', { method: 'POST' });

    assert.equal(response.status, 405);
    assert.equal(response.headers['allow'], 'GET, HEAD');
  });
});
