// The files layer over the local driver and the test database: what an
// ingest leaves behind when it does not end with a file.
//
// Run: npm test  (node:test, native type stripping — no build needed).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { startStand } from '../test-support/stand.ts';
import type { Stand } from '../test-support/stand.ts';

let stand: Stand;
let prisma: typeof import('../db/client.ts')['prisma'];
let files: typeof import('./index.ts');
let filesRoot: string;

// Everything the driver keeps on disk: objects, their folders, parts.
async function stored(): Promise<string[]> {
  const entries = await fs.readdir(filesRoot, { recursive: true }).catch(() => []);

  return entries.sort();
}

before(async () => {
  stand = await startStand();
  ({ prisma } = await import('../db/client.ts'));
  files = await import('./index.ts');
  filesRoot = (await import('../config/index.ts')).config.filesRoot;
  // The folder of the scope stays once made; a file has a folder of its own
  // inside it.
  await fs.mkdir(path.join(filesRoot, 'test'), { recursive: true });
});

after(() => stand.stop());

test('an upload the signal cuts leaves neither an object nor a row; without the cut the same body is a file', async () => {
  const body = () => {
    const stream = new Readable({ read() {} });

    stream.push(Buffer.from('the first part'));

    return stream;
  };
  const cutting = new AbortController();
  const objects = await stored();
  const rows = await prisma.file.count();
  const cut = files.ingestFile({ body: body(), originalFilename: 'cut.bin', workspaceId: stand.workspaceId, scope: 'test', signal: cutting.signal });

  setTimeout(() => cutting.abort(), 100);
  await assert.rejects(cut, { name: 'AbortError' });
  assert.deepEqual(await stored(), objects);
  assert.equal(await prisma.file.count(), rows);

  // A signal that fired before the upload: nothing is taken.
  await assert.rejects(files.ingestFile({ body: body(), originalFilename: 'late.bin', workspaceId: stand.workspaceId, scope: 'test', signal: cutting.signal }), { name: 'AbortError' });
  assert.deepEqual(await stored(), objects);

  const whole = body();

  whole.push(null);

  const file = await files.ingestFile({ body: whole, originalFilename: 'whole.bin', workspaceId: stand.workspaceId, scope: 'test', signal: new AbortController().signal });

  assert.equal(file.sizeBytes, 14);
  assert.equal(await new Response(await files.openFileContent(file.id)).text(), 'the first part');
});

test('an object whose row could not be written does not stay in storage', async () => {
  const objects = await stored();
  const rows = await prisma.file.count();

  // A width no column of the row holds.
  await assert.rejects(files.ingestFile({ body: Buffer.from('bytes'), originalFilename: 'orphan.bin', workspaceId: stand.workspaceId, scope: 'test', width: 2 ** 40 }));
  assert.deepEqual(await stored(), objects);
  assert.equal(await prisma.file.count(), rows);
});

test('the key of a long name that is not ASCII fits a file name of the disk, cut at a character with the extension kept', async () => {
  const name = `${'я'.repeat(90)}${'😀'.repeat(60)}.pdf`;
  const file = await files.ingestFile({ body: Buffer.from('%PDF'), originalFilename: name, workspaceId: stand.workspaceId, scope: 'test' });
  const { objectKey } = await prisma.file.findUniqueOrThrow({ where: { id: file.id } });
  const segment = path.basename(objectKey);

  // 180 bytes of the letters, four of them of one emoji, and the extension.
  assert.equal(segment, `${'я'.repeat(90)}${'😀'.repeat(4)}.pdf`);
  assert.ok(Buffer.byteLength(segment) <= 200);
  assert.equal(file.originalFilename, name);
  assert.equal(await new Response(await files.openFileContent(file.id)).text(), '%PDF');
});
