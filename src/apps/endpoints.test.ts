// Targeted tests of the bulk window of app endpoints: the manifest opt-in
// (manifest.ts), the caps it selects and the concurrency fence
// (endpoints.ts), the read-only connection of the SQL child (child.ts) and
// the gzip wire of large answers (wire.ts). The child tests run real
// node:sqlite children over a scratch database.
//
// Run: npm test  (node:test, native type stripping — no build needed).

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { gunzipSync } from 'node:zlib';
import type { Readable } from 'node:stream';
import { appManifestSchema } from './manifest.ts';
import { BULK_MAX_BYTES, BULK_MAX_IN_FLIGHT, BULK_MAX_ROWS, BulkSlots, endpointCaps } from './endpoints.ts';
import { GZIP_MIN_CHARS, acceptsGzip, encodeJsonResponse } from './wire.ts';
import { statementInChild } from '../workspace/child.ts';

const ROWS = 1_000;

let root: string;
let dbPath: string;

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'balabash-endpoints-test-'));
  dbPath = path.join(root, 'workspace.sqlite');

  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('CREATE TABLE points (id INTEGER PRIMARY KEY, t REAL, v REAL)');
  const insert = db.prepare('INSERT INTO points (t, v) VALUES (?, ?)');
  db.exec('BEGIN');
  for (let i = 0; i < ROWS; i += 1) insert.run(i / 10, (i * 7) % 100);
  db.exec('COMMIT');
  db.close();
});

after(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function manifestWith(endpoint: Record<string, unknown>) {
  return appManifestSchema.safeParse({ name: 'x', entry: 'app.tsx', api: { ep: endpoint } });
}

describe('manifest: the bulk opt-in', () => {
  test('defaults to false and is accepted for kind all', () => {
    const plain = manifestWith({ statement: 'SELECT 1', kind: 'all' });
    assert.ok(plain.success);
    assert.equal(plain.success && plain.data.api.ep?.bulk, false);

    const bulk = manifestWith({ statement: 'SELECT 1', kind: 'all', bulk: true });
    assert.ok(bulk.success);
    assert.equal(bulk.success && bulk.data.api.ep?.bulk, true);
  });

  test('is rejected for run and get endpoints', () => {
    for (const kind of ['run', 'get']) {
      const result = manifestWith({ statement: 'SELECT 1', kind, bulk: true });
      assert.ok(!result.success, `bulk with kind ${kind} must fail`);
      assert.match(result.success ? '' : result.error.issues.map(i => i.message).join('; '), /kind "all"/);
    }
  });

  test('must be a boolean', () => {
    assert.ok(!manifestWith({ statement: 'SELECT 1', kind: 'all', bulk: 'yes' }).success);
  });
});

describe('endpoint caps', () => {
  test('the ordinary window stays 200 rows / 50 KB; bulk gets the ceiling with the same timeout', () => {
    const plain = endpointCaps({ bulk: false });
    const bulk = endpointCaps({ bulk: true });

    assert.deepEqual([plain.maxRows, plain.maxBytes], [200, 50_000]);
    assert.deepEqual([bulk.maxRows, bulk.maxBytes], [BULK_MAX_ROWS, BULK_MAX_BYTES]);
    assert.equal(bulk.timeoutMs, plain.timeoutMs);
    assert.ok(BULK_MAX_ROWS >= 100_000 && BULK_MAX_BYTES >= 8_000_000, 'the ceiling fits the 84 489-row / 6.3 MB dataset');
  });
});

describe('bulk slots (the concurrency fence)', () => {
  test('refuses the call past the limit and frees the slot afterwards', async () => {
    const slots = new BulkSlots(2);
    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));

    const first = slots.run(() => gate.then(() => 'a'));
    const second = slots.run(() => gate.then(() => 'b'));
    const third = await slots.run(async () => 'c');

    assert.deepEqual(third, { taken: false });
    assert.equal(slots.active, 2);

    release();
    assert.deepEqual(await first, { taken: true, value: 'a' });
    assert.deepEqual(await second, { taken: true, value: 'b' });
    assert.equal(slots.active, 0);

    assert.deepEqual(await slots.run(async () => 'd'), { taken: true, value: 'd' });
  });

  test('a throwing call frees its slot too', async () => {
    const slots = new BulkSlots(1);
    await assert.rejects(slots.run(async () => { throw new Error('boom'); }), /boom/);
    assert.equal(slots.active, 0);
  });

  test('the platform limit is small', () => {
    assert.ok(BULK_MAX_IN_FLIGHT >= 1 && BULK_MAX_IN_FLIGHT <= 4);
  });
});

describe('SQL child: bulk statements', () => {
  const call = { statement: 'SELECT t, v FROM points ORDER BY id', kind: 'all' as const, params: {} };

  test('the ordinary window truncates a large result at 200 rows', async () => {
    const outcome = await statementInChild(dbPath, root, call, endpointCaps({ bulk: false }));

    assert.equal(outcome.status, 'ok');
    assert.equal(outcome.status === 'ok' && outcome.result.rowCount, 200);
    assert.equal(outcome.status === 'ok' && outcome.result.truncated, true);
  });

  test('the bulk window returns the whole result on a read-only connection', async () => {
    const outcome = await statementInChild(dbPath, root, { ...call, readOnly: true }, endpointCaps({ bulk: true }));

    assert.equal(outcome.status, 'ok');
    assert.equal(outcome.status === 'ok' && outcome.result.rowCount, ROWS);
    assert.equal(outcome.status === 'ok' && outcome.result.truncated, false);
    assert.deepEqual(outcome.status === 'ok' && (outcome.result.rows as unknown[])[ROWS - 1], { t: (ROWS - 1) / 10, v: ((ROWS - 1) * 7) % 100 });
  });

  test('a read-only bulk connection cannot write, whatever the statement says', async () => {
    const outcome = await statementInChild(
      dbPath,
      root,
      { statement: 'INSERT INTO points (t, v) VALUES (0, 0)', kind: 'all', params: {}, readOnly: true },
      endpointCaps({ bulk: true }),
    );

    assert.equal(outcome.status, 'sql_error');
    assert.match(outcome.status === 'sql_error' ? outcome.message : '', /readonly/i);

    const db = new DatabaseSync(dbPath, { readOnly: true });
    assert.equal((db.prepare('SELECT count(*) AS n FROM points').get() as { n: number }).n, ROWS);
    db.close();
  });

  test('the bulk ceiling still applies', async () => {
    const outcome = await statementInChild(dbPath, root, { ...call, readOnly: true }, { ...endpointCaps({ bulk: true }), maxRows: 300 });

    assert.equal(outcome.status, 'ok');
    assert.equal(outcome.status === 'ok' && outcome.result.rowCount, 300);
    assert.equal(outcome.status === 'ok' && outcome.result.truncated, true);
  });
});

async function drain(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

describe('wire: gzip of large answers', () => {
  const big = JSON.stringify({ result: Array.from({ length: 5_000 }, (_, i) => ({ t: i / 10, v: i % 100 })) });
  const small = JSON.stringify({ result: [{ t: 1, v: 2 }] });

  test('acceptsGzip reads the header', () => {
    assert.equal(acceptsGzip('gzip, deflate, br'), true);
    assert.equal(acceptsGzip('br;q=1.0, gzip;q=0.8'), true);
    assert.equal(acceptsGzip('*'), true);
    assert.equal(acceptsGzip('gzip;q=0'), false);
    assert.equal(acceptsGzip('br'), false);
    assert.equal(acceptsGzip(undefined), false);
  });

  test('a large answer is gzipped when accepted and round-trips', async () => {
    assert.ok(big.length >= GZIP_MIN_CHARS);
    const encoded = encodeJsonResponse(big, 'gzip, deflate');

    assert.equal(encoded.encoding, 'gzip');
    const bytes = await drain(encoded.body as Readable);
    assert.ok(bytes.length < big.length / 3, `gzip shrank ${big.length} → ${bytes.length}`);
    assert.equal(gunzipSync(bytes).toString('utf8'), big);
  });

  test('small answers and clients without gzip get the plain string', () => {
    assert.deepEqual(encodeJsonResponse(small, 'gzip'), { encoding: null, body: small });
    assert.deepEqual(encodeJsonResponse(big, undefined), { encoding: null, body: big });
  });
});
