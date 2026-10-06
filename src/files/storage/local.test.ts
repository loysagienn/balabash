import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import {
  deleteLocalObject,
  localObjectSize,
  openLocalObject,
  resolveLocalPath,
  signDownloadLink,
  verifyDownloadLink,
  writeLocalObject,
} from './local.ts';

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'balabash-files-'));

  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of Readable.fromWeb(stream as never)) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString('utf8');
}

test('local driver: write, read, size, delete under the root', async () => {
  await withRoot(async root => {
    const key = 'ccr/0f1e2d3c/report.txt';
    const { sizeBytes, etag } = await writeLocalObject(root, key, Readable.from(['hello ', 'files']));

    assert.equal(sizeBytes, 11);
    assert.match(etag, /^"[0-9a-f]{32}"$/);
    assert.equal(await readFile(path.join(root, key), 'utf8'), 'hello files');
    assert.equal(await readAll(openLocalObject(root, key)), 'hello files');
    assert.equal(await localObjectSize(root, key), 11);

    // A second write under the same key never overwrites (flags: wx).
    await assert.rejects(writeLocalObject(root, key, 'again'));

    await deleteLocalObject(root, key);
    assert.equal(await localObjectSize(root, key), null);
    // The uuid directory went with the file; the scope directory stays.
    await assert.rejects(readFile(path.join(root, 'ccr/0f1e2d3c')));
    assert.equal(await localObjectSize(root, 'ccr/other/x'), null);

    // Deleting a missing object is a no-op.
    await deleteLocalObject(root, key);
  });
});

test('local driver: keys never escape the root', async () => {
  await withRoot(async root => {
    assert.throws(() => resolveLocalPath(root, '../outside.txt'));
    assert.throws(() => resolveLocalPath(root, '/etc/passwd'));
    assert.throws(() => resolveLocalPath(root, ''));
    assert.equal(resolveLocalPath(root, 'a/b.txt'), path.join(root, 'a', 'b.txt'));
  });
});

test('signed download links: valid until exp, bound to fileId and secret', () => {
  const { url, expiresAt } = signDownloadLink({
    origin: 'https://balabash.example.com/',
    secret: 'pepper',
    fileId: 'file-1',
    expiresInSeconds: 60,
  });
  const parsed = new URL(url);

  assert.equal(parsed.origin, 'https://balabash.example.com');
  assert.equal(parsed.pathname, '/files/dl/file-1');
  assert.ok(expiresAt.getTime() > Date.now());

  const exp = parsed.searchParams.get('exp') ?? undefined;
  const sig = parsed.searchParams.get('sig') ?? undefined;

  assert.equal(verifyDownloadLink({ secret: 'pepper', fileId: 'file-1', exp, sig }), true);
  assert.equal(verifyDownloadLink({ secret: 'other', fileId: 'file-1', exp, sig }), false);
  assert.equal(verifyDownloadLink({ secret: 'pepper', fileId: 'file-2', exp, sig }), false);
  assert.equal(verifyDownloadLink({ secret: 'pepper', fileId: 'file-1', exp: String(Number(exp) + 1), sig }), false);
  assert.equal(verifyDownloadLink({ secret: 'pepper', fileId: 'file-1', exp, sig: undefined }), false);
  assert.equal(
    verifyDownloadLink({ secret: 'pepper', fileId: 'file-1', exp, sig, now: (Number(exp) + 1) * 1000 }),
    false,
  );
});
