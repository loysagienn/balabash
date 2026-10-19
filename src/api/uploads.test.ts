// Uploads over the stand (src/test-support/stand.ts): the file area's
// POST /files/<rel> — a new file from the request body, a taken name refused
// unless the request answers the clash (replace, keep → "name (n).ext"),
// the folder's boundary, the client leaving midway leaves nothing, no event;
// the composer's POST /api/files — a stored file of the session's workspace
// (scope web) from the body, the name and type from the headers, a declared
// length required, the limit, nothing stored for a request cut off; and
// POST /api/threads/:id/messages with fileIds — a message of files alone or
// with text in the channels' form, a foreign or missing file refusing the
// whole message by name.
//
// Run: npm test  (node:test, native type stripping — no build needed).

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { STAND_HOST, startStand } from '../test-support/stand.ts';
import type { Stand } from '../test-support/stand.ts';
import type { PostThreadMessageResponse, UploadFileResponse, WorkspaceUploadResponse } from './contract.ts';
import { UPLOAD_MAX_BYTES } from '../utils/file-names.ts';

type ErrorBody = { error: { code: string; message: string; fileIds?: string[] } };

let stand: Stand;
let prisma: typeof import('../db/client.ts')['prisma'];
let filesDir: string;
let tmpDir: string;

before(async () => {
  stand = await startStand();
  ({ prisma } = await import('../db/client.ts'));

  const layout = await import('../workspace/layout.ts');

  filesDir = layout.workspaceFilesDir(stand.workspaceId);
  tmpDir = layout.workspaceTmpDir(stand.workspaceId);
});

after(() => stand.stop());

const BASE_HEADERS = () => ({ host: STAND_HOST, 'x-forwarded-proto': 'https', cookie: stand.cookie });

// A raw request whose body is sent in part and then cut off: the client
// leaving midway (a cancel, a closed tab). Resolves once the socket is gone.
function cutOff(method: string, urlPath: string, headers: Record<string, string>, declared: number, sent: Buffer): Promise<void> {
  return new Promise(resolve => {
    const req = http.request({ host: '127.0.0.1', port: stand.port, path: urlPath, method, headers: { ...BASE_HEADERS(), ...headers, 'content-length': String(declared) } });

    req.on('error', () => resolve());
    req.on('close', () => resolve());
    req.write(sent, () => setTimeout(() => req.destroy(), 50));
  });
}

// A raw request that only declares its length (and sends nothing): the
// answer to the declaration alone.
function declareOnly(method: string, urlPath: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: stand.port, path: urlPath, method, headers: { ...BASE_HEADERS(), ...headers } }, res => {
      const chunks: Buffer[] = [];

      res.on('data', chunk => chunks.push(chunk as Buffer));
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
        req.destroy();
      });
      res.on('error', reject);
    });

    req.on('error', () => {});
    req.flushHeaders();
  });
}

// A chunked request (no Content-Length) with a short body.
function chunked(method: string, urlPath: string, headers: Record<string, string>, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: stand.port, path: urlPath, method, headers: { ...BASE_HEADERS(), ...headers } }, res => {
      const chunks: Buffer[] = [];

      res.on('data', chunk => chunks.push(chunk as Buffer));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });

    req.on('error', reject);
    req.write(body.slice(0, 2));
    req.end(body.slice(2));
  });
}

async function eventCount(): Promise<number> {
  return prisma.event.count();
}

async function waitFor(check: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    if (await check()) {
      return;
    }

    await new Promise(resolve => setTimeout(resolve, 20));
  }

  assert.fail(`timed out waiting for ${what}`);
}

async function tempFiles(): Promise<string[]> {
  return (await fs.readdir(tmpDir).catch(() => [] as string[])).filter(name => name.startsWith('.upload-'));
}

describe('uploading to the file area', () => {
  const dir = 'upload-probe';
  const upload = (rel: string, text: string, query = '') =>
    stand.request('POST', `/files/${rel}${query}`, { text, headers: { 'content-type': 'application/octet-stream' } });
  const read = (rel: string) => fs.readFile(path.join(filesDir, rel), 'utf8');

  before(async () => {
    await fs.mkdir(path.join(filesDir, dir, 'sub'), { recursive: true });
  });

  after(() => fs.rm(path.join(filesDir, dir), { recursive: true, force: true }));

  test('a new file is created from the body: 201 with its node, the bytes in place, no temp file, no event', async () => {
    const events = await eventCount();
    const reply = await upload(`${dir}/photo%201.txt`, 'first bytes');

    assert.equal(reply.status, 201, reply.text);

    const { file } = reply.json<WorkspaceUploadResponse>();

    assert.equal(file.path, `${dir}/photo 1.txt`);
    assert.equal(file.sizeBytes, 11);
    assert.equal(file.mediaType, 'text/plain');
    assert.equal(await read(`${dir}/photo 1.txt`), 'first bytes');
    assert.deepEqual(await tempFiles(), []);
    assert.equal(await eventCount(), events);
  });

  test('a taken name is refused and the file stays; keep — the next free "name (n).ext"; replace — the new bytes take the name', async () => {
    const taken = await upload(`${dir}/photo%201.txt`, 'second bytes');

    assert.equal(taken.status, 409);
    assert.equal(taken.json<ErrorBody>().error.code, 'exists');
    assert.equal(await read(`${dir}/photo 1.txt`), 'first bytes');

    const kept = await upload(`${dir}/photo%201.txt`, 'second bytes', '?conflict=keep');

    assert.equal(kept.status, 201, kept.text);
    assert.equal(kept.json<WorkspaceUploadResponse>().file.path, `${dir}/photo 1 (2).txt`);
    assert.equal(await read(`${dir}/photo 1 (2).txt`), 'second bytes');

    const keptAgain = await upload(`${dir}/photo%201.txt`, 'third bytes', '?conflict=keep');

    assert.equal(keptAgain.json<WorkspaceUploadResponse>().file.path, `${dir}/photo 1 (3).txt`);

    const replaced = await upload(`${dir}/photo%201.txt`, 'replacing bytes', '?conflict=replace');

    assert.equal(replaced.status, 201, replaced.text);
    assert.equal(replaced.json<WorkspaceUploadResponse>().file.path, `${dir}/photo 1.txt`);
    assert.equal(await read(`${dir}/photo 1.txt`), 'replacing bytes');
    assert.deepEqual((await fs.readdir(path.join(filesDir, dir))).filter(name => name.startsWith('.')), []);
    assert.deepEqual(await tempFiles(), []);
  });

  test('a folder under the name is not replaced; an unknown answer to a clash is a bad request', async () => {
    const folder = await upload(`${dir}/sub`, 'bytes', '?conflict=replace');

    assert.equal(folder.status, 409);
    assert.equal(folder.json<ErrorBody>().error.code, 'not_a_file');
    assert.ok((await fs.stat(path.join(filesDir, dir, 'sub'))).isDirectory());

    const unknown = await upload(`${dir}/new.txt`, 'bytes', '?conflict=overwrite');

    assert.equal(unknown.status, 400);
    await assert.rejects(fs.stat(path.join(filesDir, dir, 'new.txt')));
  });

  test('the folder must be there and inside the area: a missing one and a link to a folder outside are refused, nothing is created', async () => {
    const missing = await upload(`${dir}/nowhere/a.txt`, 'bytes');

    assert.equal(missing.status, 404);
    await assert.rejects(fs.stat(path.join(filesDir, dir, 'nowhere')));

    const outside = path.join(filesDir, '..', 'outside-the-area');

    await fs.mkdir(outside, { recursive: true });
    await fs.symlink(outside, path.join(filesDir, dir, 'link'));

    try {
      const through = await upload(`${dir}/link/a.txt`, 'bytes');

      assert.equal(through.status, 404);
      assert.deepEqual(await fs.readdir(outside), []);
    } finally {
      await fs.rm(path.join(filesDir, dir, 'link'), { force: true });
      await fs.rm(outside, { recursive: true, force: true });
    }

    const escape = await upload('..%2F..%2Fescape.txt', 'bytes');

    assert.equal(escape.status, 400);
  });

  test('a declared length over the limit is refused before a byte is read', async () => {
    const reply = await declareOnly('POST', `/files/${dir}/huge.bin`, { 'content-length': String(UPLOAD_MAX_BYTES + 1) });

    assert.equal(reply.status, 413, reply.body);
    await assert.rejects(fs.stat(path.join(filesDir, dir, 'huge.bin')));
  });

  test('a client leaving midway is the cancel: no file, no temp file left', async () => {
    await cutOff('POST', `/files/${dir}/cut.bin`, { 'content-type': 'application/octet-stream' }, 4 * 1024 * 1024, Buffer.alloc(256 * 1024, 1));
    await waitFor(async () => (await tempFiles()).length === 0, 'the temp file to go');
    await assert.rejects(fs.stat(path.join(filesDir, dir, 'cut.bin')));
  });

  test('the upload is a mutation under the session: signed out it is a 401, cross-site a 403, nothing is created', async () => {
    const signedOut = await stand.request('POST', `/files/${dir}/x.txt`, { text: 'x', cookie: null });

    assert.equal(signedOut.status, 401);

    const crossSite = await stand.request('POST', `/files/${dir}/x.txt`, { text: 'x', headers: { 'sec-fetch-site': 'cross-site', origin: `https://${STAND_HOST}` } });

    assert.equal(crossSite.status, 403);
    await assert.rejects(fs.stat(path.join(filesDir, dir, 'x.txt')));
  });
});

describe('uploading an attachment to storage', () => {
  const store = (text: string, headers: Record<string, string>) => stand.request('POST', '/api/files', { text, headers });

  test('the body becomes a stored file of the workspace: the name and type from the headers, scope web, the bytes readable by id', async () => {
    const reply = await store('%PDF-1.4 bytes', { 'content-type': 'application/pdf', 'x-balabash-filename': encodeURIComponent('отчёт за май.pdf') });

    assert.equal(reply.status, 201, reply.text);

    const { file } = reply.json<UploadFileResponse>();

    assert.deepEqual({ ...file, fileId: typeof file.fileId }, { fileId: 'string', name: 'отчёт за май.pdf', contentType: 'application/pdf', sizeBytes: 14, width: null, height: null });

    const row = await prisma.file.findUnique({ where: { id: file.fileId } });

    assert.equal(row?.workspaceId, stand.workspaceId);
    assert.equal(row?.scope, 'web');
    assert.ok(row?.uploadedAt);

    const bytes = await stand.request('GET', `/api/files/${file.fileId}`);

    assert.equal(bytes.status, 200);
    assert.equal(bytes.text, '%PDF-1.4 bytes');
  });

  test('a generic type takes the type of the name’s extension; a path in the name keeps only its last segment', async () => {
    const reply = await store('png bytes', { 'content-type': 'application/octet-stream', 'x-balabash-filename': encodeURIComponent('../../shot.png') });

    assert.equal(reply.status, 201, reply.text);
    assert.equal(reply.json<UploadFileResponse>().file.contentType, 'image/png');
    assert.equal(reply.json<UploadFileResponse>().file.name, 'shot.png');
  });

  test('refusals store nothing: no name, no declared length, a declared length over the limit, another workspace', async () => {
    const rows = await prisma.file.count();
    const noName = await store('bytes', { 'content-type': 'text/plain' });

    assert.equal(noName.status, 400);

    const noLength = await chunked('POST', '/api/files', { 'x-balabash-filename': 'a.txt', 'content-type': 'text/plain' }, 'bytes');

    assert.equal(noLength.status, 411, noLength.body);

    const huge = await declareOnly('POST', '/api/files', { 'x-balabash-filename': 'a.bin', 'content-length': String(UPLOAD_MAX_BYTES + 1) });

    assert.equal(huge.status, 413, huge.body);

    const other = await prisma.workspace.create({ data: {} });
    const foreign = await store('bytes', { 'x-balabash-filename': 'a.txt', 'x-balabash-workspace': other.id });

    assert.equal(foreign.status, 401);
    assert.equal(await prisma.file.count(), rows);
  });

  test('a request cut off midway stores nothing: no row, no object left in storage', async () => {
    const rows = await prisma.file.count();
    const storageRoot = path.join(stand.dir, 'files', 'web');
    const objectsBefore = await fs.readdir(storageRoot).catch(() => [] as string[]);

    await cutOff('POST', '/api/files', { 'x-balabash-filename': 'cut.bin', 'content-type': 'application/octet-stream' }, 4 * 1024 * 1024, Buffer.alloc(256 * 1024, 2));
    await waitFor(async () => (await fs.readdir(storageRoot).catch(() => [] as string[])).length === objectsBefore.length, 'the partial object to go');
    assert.equal(await prisma.file.count(), rows);
  });
});

describe('a message with files', () => {
  const send = (body: unknown) => stand.request('POST', `/api/threads/${stand.mainThreadId}/messages`, { body });
  let pdf: string;
  let image: string;

  before(async () => {
    pdf = (await stand.request('POST', '/api/files', { text: 'pdf', headers: { 'content-type': 'application/pdf', 'x-balabash-filename': 'invoice.pdf' } })).json<UploadFileResponse>().file.fileId;
    image = (await stand.request('POST', '/api/files', { text: 'png', headers: { 'content-type': 'image/png', 'x-balabash-filename': 'wall.png' } })).json<UploadFileResponse>().file.fileId;
  });

  test('files alone: a user.message without text, with the files and their blocks as the channels write them', async () => {
    const reply = await send({ fileIds: [pdf, image] });

    assert.equal(reply.status, 200, reply.text);

    const { event } = reply.json<PostThreadMessageResponse>();

    assert.equal(event.type, 'user.message');
    assert.deepEqual(event.payload, {
      text: null,
      blocks: [
        { type: 'file', fileId: pdf, name: 'invoice.pdf', mimeType: 'application/pdf', size: 3 },
        { type: 'image', fileId: image, name: 'wall.png', mimeType: 'image/png', size: 3 },
      ],
      files: [
        { fileId: pdf, contentType: 'application/pdf', originalFilename: 'invoice.pdf', sizeBytes: 3 },
        { fileId: image, contentType: 'image/png', originalFilename: 'wall.png', sizeBytes: 3 },
      ],
      identity: { username: 'operator' },
      source: 'web',
    });
  });

  test('text with a file; text alone still goes as before', async () => {
    const both = await send({ text: '  Here is the wall  ', fileIds: [image, image] });

    assert.equal(both.status, 200, both.text);

    const payload = both.json<PostThreadMessageResponse>().event.payload as { text: string; files: unknown[] };

    assert.equal(payload.text, 'Here is the wall');
    assert.equal(payload.files.length, 1);

    const plain = await send({ text: 'Just text' });

    assert.equal(plain.status, 200);
    assert.deepEqual(plain.json<PostThreadMessageResponse>().event.payload, { text: 'Just text', identity: { username: 'operator' }, source: 'web' });
  });

  test('a foreign or a missing file refuses the whole message by name, and nothing is written', async () => {
    const other = await prisma.workspace.create({ data: {} });
    const { ingestFile } = await import('../files/index.ts');
    const foreign = await ingestFile({ body: 'theirs', workspaceId: other.id, originalFilename: 'theirs.txt', contentType: 'text/plain', scope: 'web' });
    const missing = '00000000-0000-4000-8000-000000000000';
    const events = await eventCount();
    const reply = await send({ text: 'with a stranger', fileIds: [pdf, foreign.id, missing] });

    assert.equal(reply.status, 400);
    assert.deepEqual(reply.json<ErrorBody>().error, { code: 'file_not_accepted', message: '2 files were not accepted', fileIds: [foreign.id, missing] });
    assert.equal(await eventCount(), events);
  });

  test('a message needs text or files; fileIds must be ids, at most 20', async () => {
    assert.equal((await send({ text: '   ' })).status, 400);
    assert.equal((await send({ fileIds: [] })).status, 400);
    assert.equal((await send({ fileIds: 'x' })).status, 400);
    assert.equal((await send({ fileIds: [5] })).status, 400);
    assert.equal((await send({ text: 'x', fileIds: Array.from({ length: 21 }, (_, i) => `id-${i}`) })).status, 400);
  });
});

describe('the coordinator hands files to a child', () => {
  test('send_to_thread with fileIds: a thread.message with the references and their facts; a foreign file rejects the call and nothing is written', async () => {
    const { startThread } = await import('../core/threads.ts');
    const { dispatchCoordinatorFunction } = await import('../coordinator/functions.ts');
    const { ingestFile } = await import('../files/index.ts');
    const child = await startThread({ workspaceId: stand.workspaceId, parentThreadId: stand.mainThreadId, agent: 'engineer', title: 'with files', actor: 'system' });
    const own = await ingestFile({ body: 'spec', workspaceId: stand.workspaceId, originalFilename: 'spec.md', contentType: 'text/markdown', scope: 'web' });
    const ctx = { workspaceId: stand.workspaceId, threadId: stand.mainThreadId };
    const sent = await dispatchCoordinatorFunction(
      { name: 'send_to_thread', callId: 'c1', arguments: JSON.stringify({ threadId: child.id, text: 'Here is the spec', fileIds: [own.id] }) } as never,
      ctx,
    );

    assert.deepEqual(sent, { kind: 'async' });

    const message = await prisma.event.findFirst({ where: { type: 'thread.message', targetThreadId: child.id }, orderBy: { seq: 'desc' } });

    assert.deepEqual(message?.payload, {
      text: 'Here is the spec',
      fileIds: [own.id],
      files: [{ fileId: own.id, contentType: 'text/markdown', originalFilename: 'spec.md', sizeBytes: 4 }],
    });

    const other = await prisma.workspace.create({ data: {} });
    const foreign = await ingestFile({ body: 'theirs', workspaceId: other.id, originalFilename: 'theirs.md', contentType: 'text/markdown', scope: 'web' });
    const events = await eventCount();
    const refused = await dispatchCoordinatorFunction(
      { name: 'send_to_thread', callId: 'c2', arguments: JSON.stringify({ threadId: child.id, text: 'And this', fileIds: [foreign.id] }) } as never,
      ctx,
    );

    assert.equal((refused as { kind: string }).kind, 'rejected');
    assert.equal(await eventCount(), events);

    const plain = await dispatchCoordinatorFunction({ name: 'send_to_thread', callId: 'c3', arguments: JSON.stringify({ threadId: child.id, text: 'No files', fileIds: null }) } as never, ctx);

    assert.deepEqual(plain, { kind: 'async' });
  });
});

describe('an import that never overwrites', () => {
  test('placeImport: a free name takes the file; the same bytes keep their path; other bytes land beside as "name (2).ext"', async () => {
    const { fileDigest, placeImport } = await import('../workspace/files.ts');

    await fs.mkdir(path.join(filesDir, 'imports'), { recursive: true });
    await fs.mkdir(tmpDir, { recursive: true });

    const received = async (content: string) => {
      const temp = path.join(tmpDir, `.import-test-${Math.random().toString(16).slice(2)}`);

      await fs.writeFile(temp, content);

      return { temp, digest: await fileDigest(temp) };
    };

    const first = await received('version one');
    const placed = await placeImport(stand.workspaceId, 'imports/plan.pdf', first.temp, first.digest);

    assert.deepEqual({ path: placed.path, reused: placed.reused }, { path: 'imports/plan.pdf', reused: false });

    const again = await received('version one');
    const same = await placeImport(stand.workspaceId, 'imports/plan.pdf', again.temp, again.digest);

    assert.deepEqual({ path: same.path, reused: same.reused }, { path: 'imports/plan.pdf', reused: true });

    const changed = await received('version two');
    const beside = await placeImport(stand.workspaceId, 'imports/plan.pdf', changed.temp, changed.digest);

    assert.deepEqual({ path: beside.path, reused: beside.reused }, { path: 'imports/plan (2).pdf', reused: false });
    assert.equal(await fs.readFile(path.join(filesDir, 'imports/plan.pdf'), 'utf8'), 'version one');
    assert.equal(await fs.readFile(path.join(filesDir, 'imports/plan (2).pdf'), 'utf8'), 'version two');

    // The temp files are gone whatever the outcome.
    assert.deepEqual((await fs.readdir(tmpDir)).filter(name => name.startsWith('.import-test-')), []);
  });
});
