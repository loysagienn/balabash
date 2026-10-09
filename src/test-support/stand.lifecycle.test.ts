// The lifecycle of the stand (stand.ts): the cleanup releases every step
// whatever failed, a listen that is refused is an error of the start and
// not an unhandled event, and a real stand stops under a stream a test left
// open — the copy, the directory and the cwd gone with it. This file's own
// stand is stopped in the middle of it (one stand per file).
//
// Run: npm test  (node:test, native type stripping — no build needed).

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';
import { STAND_HOST, closeServer, createCleanup, listen, startStand } from './stand.ts';
import type { Stand } from './stand.ts';
import { testPostgresUrl } from './pg.ts';

describe('createCleanup', () => {
  test('releases in the reverse order of acquisition, once', async () => {
    const cleanup = createCleanup();
    const calls: string[] = [];

    cleanup.add('a', () => {
      calls.push('a');
    });
    cleanup.add('b', async () => {
      await sleep(5);
      calls.push('b');
    });
    cleanup.add('c', () => {
      calls.push('c');
    });

    await cleanup.run();
    await cleanup.run();

    assert.deepEqual(calls, ['c', 'b', 'a']);
  });

  test('a failing step skips nothing; the failures come back together, named', async () => {
    const cleanup = createCleanup();
    const calls: string[] = [];

    cleanup.add('drop the database copy', () => {
      calls.push('drop');
    });
    cleanup.add('remove the directory', () => Promise.reject(new Error('EBUSY')));
    cleanup.add('restore cwd', () => {
      calls.push('cwd');
    });
    cleanup.add('disconnect', () => {
      throw new Error('ECONNRESET');
    });

    await assert.rejects(cleanup.run(), (error: AggregateError) => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.message, /^the stand's cleanup failed — disconnect: ECONNRESET; remove the directory: EBUSY$/);
      assert.deepEqual(error.errors.map(failure => (failure as Error).message), ['disconnect: ECONNRESET', 'remove the directory: EBUSY']);

      return true;
    });
    assert.deepEqual(calls, ['cwd', 'drop']);

    // Nothing is left to run — and nothing runs twice.
    await cleanup.run();
    assert.deepEqual(calls, ['cwd', 'drop']);
  });
});

describe('listen', () => {
  // http.Server has a 'listening' handler of its own (connection tracking) —
  // the counts are compared with the ones before the listen.
  const handlers = (server: http.Server) => ({ error: server.listenerCount('error'), listening: server.listenerCount('listening') });

  test('resolves with the address and leaves no handler behind', async () => {
    const server = http.createServer();
    const before = handlers(server);
    const address = await listen(server, 0, '127.0.0.1');

    try {
      assert.equal(address.address, '127.0.0.1');
      assert.ok(address.port > 0);
      assert.deepEqual(handlers(server), before);
    } finally {
      await closeServer(server);
    }
  });

  test('a refused bind rejects instead of an unhandled error event', async () => {
    const taken = net.createServer();

    await new Promise<void>(resolve => taken.listen(0, '127.0.0.1', () => resolve()));

    const { port } = taken.address() as net.AddressInfo;
    const server = http.createServer();
    const before = handlers(server);

    try {
      await assert.rejects(listen(server, port, '127.0.0.1'), { code: 'EADDRINUSE' });
      assert.deepEqual(handlers(server), before);
    } finally {
      await new Promise<void>(resolve => taken.close(() => resolve()));
    }
  });
});

describe('closeServer', () => {
  test('comes back with an open response still flowing', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': connected\n\n');
    });
    const { port } = await listen(server, 0, '127.0.0.1');
    // The response is flowing once its first chunk arrived; its end is the
    // socket's close.
    const response = await new Promise<http.IncomingMessage>(resolve => {
      http.get({ host: '127.0.0.1', port, path: '/' }, res => res.once('data', () => resolve(res)));
    });
    const ended = new Promise<void>(resolve => response.once('close', () => resolve()));

    await closeServer(server);
    await ended;
  });
});

describe('a stand stopped under an open event stream', () => {
  let stand: Stand;
  let cwd: string;

  before(async () => {
    cwd = process.cwd();
    stand = await startStand();
  });

  test('request() is left through its signal', async () => {
    const controller = new AbortController();
    const streaming = stand.request('GET', '/api/events/stream?after=0', { signal: controller.signal });

    await sleep(100);
    controller.abort();

    await assert.rejects(streaming, { name: 'AbortError' });
  });

  test('stop() cuts the stream and releases the copy, the directory and the cwd', async () => {
    // A raw client on the stand's port: the stream is open once its first
    // comment has arrived, and its end is observed as the socket's close.
    const stream = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = http.get(
        { host: '127.0.0.1', port: stand.port, path: '/api/events/stream?after=0', headers: { host: STAND_HOST, 'x-forwarded-proto': 'https', cookie: stand.cookie } },
        res => {
          res.once('data', chunk => {
            assert.match(String(chunk), /^: connected/);
            resolve(res);
          });
        },
      );

      req.on('error', reject);
    });

    assert.equal(stream.statusCode, 200);
    assert.match(stream.headers['content-type'] ?? '', /^text\/event-stream/);

    const closed = new Promise<void>(resolve => stream.once('close', () => resolve()));
    const stopped = await Promise.race([stand.stop().then(() => 'stopped'), sleep(10_000).then(() => 'still running after 10 s')]);

    assert.equal(stopped, 'stopped');
    await closed;

    assert.equal(process.cwd(), cwd);
    assert.equal(await fs.stat(stand.dir).catch((error: NodeJS.ErrnoException) => error.code), 'ENOENT');

    const maintenance = new URL(testPostgresUrl());

    maintenance.pathname = '/postgres';

    const client = new pg.Client({ connectionString: maintenance.href });

    await client.connect();

    try {
      const { rows } = await client.query('select 1 from pg_database where datname = $1', [stand.db.name]);

      assert.deepEqual(rows, []);
    } finally {
      await client.end();
    }

    // The second stop is a no-op.
    await stand.stop();
  });
});
