// The console host branch (console.ts): host gating, the /api and /files
// pass-through, immutable assets, the no-store shell from the manifest and
// its absence, method and path refusals. A real Koa listener on an ephemeral
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
