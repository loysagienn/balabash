// The drafts of a thread's message over the stand (src/test-support/
// stand.ts): none until saved; a save over the right revision lands and
// moves the revision on, over a stale one it is a 409 with the server's
// draft and writes nothing; a cleared draft is the row emptied, never gone
// (the revision keeps growing — a stale device never meets a reused one);
// a sent message clears the draft in its own transaction; the draft is the
// user's — another user of the workspace has their own; a foreign file is
// refused; the `draft` frame reaches the user's event stream.
//
// Run: npm test  (node:test, native type stripping — no build needed).

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { STAND_HOST, sessionCookie, startStand } from '../test-support/stand.ts';
import type { Stand } from '../test-support/stand.ts';
import type { DraftConflictErrorBody, DraftResponse, DraftStreamFrame, UploadFileResponse } from './contract.ts';
import { parseJson } from '../utils/serialize-json.ts';

type ErrorBody = { error: { code: string; message: string; fileIds?: string[] } };

let stand: Stand;
let prisma: typeof import('../db/client.ts')['prisma'];
let createAuthCode: typeof import('./auth-codes.ts')['createAuthCode'];

before(async () => {
  stand = await startStand();
  ({ prisma } = await import('../db/client.ts'));
  ({ createAuthCode } = await import('./auth-codes.ts'));
});

after(() => stand.stop());

const draftPath = (threadId: string) => `/api/threads/${threadId}/draft`;

async function save(threadId: string, body: unknown, cookie?: string) {
  return stand.request('PUT', draftPath(threadId), { body, ...(cookie ? { cookie } : {}) });
}

async function read(threadId: string, cookie?: string): Promise<DraftResponse['draft']> {
  const reply = await stand.request('GET', draftPath(threadId), cookie ? { cookie } : {});

  assert.equal(reply.status, 200, reply.text);

  return reply.json<DraftResponse>().draft;
}

// Opens the user's event stream and resolves with the `draft` frames once
// `count` of them arrived.
function draftFrames(cookie: string, count: number): Promise<DraftStreamFrame[]> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: stand.port, path: '/api/events/stream?after=0', headers: { host: STAND_HOST, 'x-forwarded-proto': 'https', cookie } }, res => {
      let text = '';
      const frames: DraftStreamFrame[] = [];

      res.setEncoding('utf8');
      res.on('data', chunk => {
        text += chunk;

        const blocks = text.split('\n\n');

        text = blocks.pop() ?? '';

        for (const block of blocks) {
          const lines = block.split('\n');

          if (lines.includes('event: draft')) {
            const data = lines.find(line => line.startsWith('data: '));

            assert.ok(!lines.some(line => line.startsWith('id: ')), 'a draft frame carries no id');
            frames.push(parseJson(data!.slice(6)) as DraftStreamFrame);
          }
        }

        if (frames.length >= count) {
          req.destroy();
          resolve(frames);
        }
      });
    });

    req.on('error', error => {
      if ((error as NodeJS.ErrnoException).code !== 'ECONNRESET') {
        reject(error);
      }
    });
    req.end();
  });
}

const settle = () => new Promise(resolve => setTimeout(resolve, 30));

describe('the draft of a thread', () => {
  test('none until saved; a save over base 0 creates it at revision 1, the next over 1 moves it to 2', async () => {
    assert.equal(await read(stand.mainThreadId), null);

    const first = await save(stand.mainThreadId, { text: 'Dear ', fileIds: [], baseRevision: 0 });

    assert.equal(first.status, 200, first.text);

    const saved = first.json<DraftResponse>().draft!;

    assert.deepEqual({ ...saved, updatedAt: saved.updatedAt instanceof Date }, { threadId: stand.mainThreadId, text: 'Dear ', files: [], revision: 1, updatedAt: true });

    const second = await save(stand.mainThreadId, { text: 'Dear all,', fileIds: [], baseRevision: 1 });

    assert.equal(second.status, 200, second.text);
    assert.equal(second.json<DraftResponse>().draft!.revision, 2);
    assert.equal((await read(stand.mainThreadId))!.text, 'Dear all,');
  });

  test('a stale base is a 409 with the current draft, nothing written; base 0 over an existing draft too', async () => {
    const stale = await save(stand.mainThreadId, { text: 'from the phone, asleep for an hour', fileIds: [], baseRevision: 1 });

    assert.equal(stale.status, 409, stale.text);

    const { error } = stale.json<DraftConflictErrorBody>();

    assert.equal(error.code, 'draft_conflict');
    assert.equal(error.draft?.text, 'Dear all,');
    assert.equal(error.draft?.revision, 2);

    const fresh = await save(stand.mainThreadId, { text: 'a new tab that read nothing', fileIds: [], baseRevision: 0 });

    assert.equal(fresh.status, 409);
    assert.equal(fresh.json<DraftConflictErrorBody>().error.draft?.revision, 2);
    assert.equal((await read(stand.mainThreadId))!.text, 'Dear all,');
  });

  test('an emptied composer is the row with empty content and a revision that keeps growing', async () => {
    const cleared = await save(stand.mainThreadId, { text: '', fileIds: [], baseRevision: 2 });

    assert.equal(cleared.status, 200, cleared.text);
    assert.deepEqual([cleared.json<DraftResponse>().draft!.text, cleared.json<DraftResponse>().draft!.revision], ['', 3]);

    const again = await save(stand.mainThreadId, { text: 'Hi', fileIds: [], baseRevision: 3 });

    assert.equal(again.status, 200);
    assert.equal(again.json<DraftResponse>().draft!.revision, 4);
    assert.equal(await prisma.messageDraft.count({ where: { threadId: stand.mainThreadId } }), 1);
  });

  test('a sent message clears the draft with it: empty content, the revision moved on, a save of the sent text refused', async () => {
    const posted = await stand.request('POST', `/api/threads/${stand.mainThreadId}/messages`, { body: { text: 'Hi' } });

    assert.equal(posted.status, 200, posted.text);

    const after = await read(stand.mainThreadId);

    assert.deepEqual([after!.text, after!.revision], ['', 5]);

    const late = await save(stand.mainThreadId, { text: 'Hi', fileIds: [], baseRevision: 4 });

    assert.equal(late.status, 409);
    assert.equal(late.json<DraftConflictErrorBody>().error.draft?.text, '');
  });

  test('a message of a thread without a draft clears nothing: no row appears', async () => {
    const { appendEvent } = await import('../core/append.ts');
    const child = crypto.randomUUID();

    await appendEvent({ type: 'thread.started', actor: 'system', workspaceId: stand.workspaceId, threadId: child, targetThreadId: stand.mainThreadId, payload: { agent: 'engineer', title: 'Child' } });

    const posted = await stand.request('POST', `/api/threads/${child}/messages`, { body: { text: 'go' } });

    assert.equal(posted.status, 200, posted.text);
    assert.equal(await read(child), null);
  });

  test('the draft carries stored files with their facts; a foreign or missing file is refused as a message’s', async () => {
    const upload = await stand.request('POST', '/api/files', { text: 'bytes', headers: { 'content-type': 'text/plain', 'x-balabash-filename': 'notes.txt' } });

    assert.equal(upload.status, 201, upload.text);

    const { file } = upload.json<UploadFileResponse>();
    const saved = await save(stand.mainThreadId, { text: 'see attached', fileIds: [file.fileId], baseRevision: 5 });

    assert.equal(saved.status, 200, saved.text);
    assert.deepEqual(saved.json<DraftResponse>().draft!.files, [{ fileId: file.fileId, name: 'notes.txt', contentType: 'text/plain', sizeBytes: 5, width: null, height: null }]);
    assert.deepEqual((await read(stand.mainThreadId))!.files.map(f => f.fileId), [file.fileId]);

    const foreign = await save(stand.mainThreadId, { text: 'x', fileIds: [file.fileId, 'no-such-file'], baseRevision: 6 });

    assert.equal(foreign.status, 400);
    assert.deepEqual(foreign.json<ErrorBody>().error, { code: 'file_not_accepted', message: '1 file was not accepted', fileIds: ['no-such-file'] });
    assert.equal((await read(stand.mainThreadId))!.revision, 6);
  });

  test('a corrupted body, a non-string text, a bad base and a text over the limit are 400s', async () => {
    const cases: unknown[] = [{ fileIds: [], baseRevision: 6 }, { text: 5, baseRevision: 6 }, { text: 'x', baseRevision: -1 }, { text: 'x', baseRevision: 1.5 }, { text: 'x', fileIds: 'a', baseRevision: 6 }, { text: 'x'.repeat(20_001), baseRevision: 6 }];

    for (const body of cases) {
      const reply = await save(stand.mainThreadId, body);

      assert.equal(reply.status, 400, JSON.stringify(body).slice(0, 60));
    }

    assert.equal((await save(stand.mainThreadId, { text: 'x', baseRevision: 6 })).status, 200, 'fileIds may be left out');
  });

  test('the draft is the user’s: another user of the workspace reads none and keeps their own', async () => {
    const ksenia = (await prisma.user.create({ data: { displayName: 'Ksenia' } })).id;
    const signedIn = await stand.request('POST', '/api/auth', { body: { code: createAuthCode({ workspaceId: stand.workspaceId, userId: ksenia }, 'telegram') }, cookie: null });

    assert.equal(signedIn.status, 200, signedIn.text);

    const cookie = sessionCookie(signedIn.headers['set-cookie'] ?? []);

    assert.equal(await read(stand.mainThreadId, cookie), null);

    const hers = await save(stand.mainThreadId, { text: 'Ksenia’s', fileIds: [], baseRevision: 0 }, cookie);

    assert.equal(hers.status, 200, hers.text);
    assert.equal(hers.json<DraftResponse>().draft!.revision, 1);
    assert.equal((await read(stand.mainThreadId))!.text, 'x');
    assert.equal((await read(stand.mainThreadId, cookie))!.text, 'Ksenia’s');
  });

  test('a thread of another workspace is a 404; a thread that does not exist too', async () => {
    const other = (await prisma.workspace.create({ data: { workspaceName: 'Other' } })).id;
    const { appendEvent } = await import('../core/append.ts');
    const theirs = crypto.randomUUID();

    await appendEvent({ type: 'thread.started', actor: 'system', workspaceId: other, threadId: theirs, targetThreadId: null, payload: { agent: 'main', title: 'Main' } });

    assert.equal((await stand.request('GET', draftPath(theirs))).status, 404);
    assert.equal((await save(theirs, { text: 'x', fileIds: [], baseRevision: 0 })).status, 404);
    assert.equal((await stand.request('GET', draftPath('nope'))).status, 404);
  });

  test('a save and a sent message reach the user’s event stream as `draft` frames with the thread and the revision', async () => {
    const framesSeen = draftFrames(stand.cookie, 2);

    await settle();

    const before = (await read(stand.mainThreadId))!.revision;
    const saved = await save(stand.mainThreadId, { text: 'typing on the laptop', fileIds: [], baseRevision: before });

    assert.equal(saved.status, 200, saved.text);

    const posted = await stand.request('POST', `/api/threads/${stand.mainThreadId}/messages`, { body: { text: 'typing on the laptop' } });

    assert.equal(posted.status, 200, posted.text);
    assert.deepEqual(await framesSeen, [
      { threadId: stand.mainThreadId, revision: before + 1 },
      { threadId: stand.mainThreadId, revision: before + 2 },
    ]);
  });
});
