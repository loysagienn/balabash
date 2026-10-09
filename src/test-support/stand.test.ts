// The stand itself (stand.ts): the app's modules write to the stand's copy
// and nowhere else, the process runs in the stand's directory, the shell's
// environment is gone, the workspace is seeded and signed in, a second
// stand in the process is refused.
//
// Run: npm test  (node:test, native type stripping — no build needed).

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { BLOCKED_DATABASE_URL } from '../db/test-guard.ts';
import { startStand, sessionCookie } from './stand.ts';
import type { Stand } from './stand.ts';
import type { MeResponse } from '../api/contract.ts';

let stand: Stand;

before(async () => {
  stand = await startStand();
});

after(() => stand.stop());

describe('stand', () => {
  test('the app’s client reaches the copy, under the lock', async () => {
    const { prisma } = await import('../db/client.ts');
    const [row] = await prisma.$queryRaw<{ name: string }[]>`select current_database() as name`;

    assert.equal(row.name, stand.db.name);
    assert.match(stand.db.name, /_test$/);
    assert.equal(process.env.DATABASE_URL, stand.db.url);
    assert.notEqual(process.env.DATABASE_URL, BLOCKED_DATABASE_URL);
    assert.ok(process.env.NODE_TEST_CONTEXT);
  });

  test('the process runs in the stand’s directory and the workspace layout follows', async () => {
    const { workspaceFilesDir } = await import('../workspace/layout.ts');
    const { config } = await import('../config/index.ts');

    assert.equal(await fs.realpath(process.cwd()), await fs.realpath(stand.dir));
    assert.equal(workspaceFilesDir(stand.userId), path.join(process.cwd(), 'data', 'workspace', stand.userId, 'files'));
    assert.equal(config.fileStorage, 'local');
    assert.equal(config.filesRoot, path.join(process.cwd(), 'files'));
    assert.equal(config.telegramEnabled, false);
    assert.equal(config.consoleDomain, null);
    assert.equal(process.env.OPENAI_API_KEY, undefined);
  });

  test('the workspace is seeded: one user, its main thread, a web session', async () => {
    const { prisma } = await import('../db/client.ts');

    assert.deepEqual(await prisma.user.findMany({ select: { id: true } }), [{ id: stand.userId }]);
    assert.deepEqual(
      await prisma.thread.findMany({ select: { id: true, parentId: true, agent: true, status: true } }),
      [{ id: stand.mainThreadId, parentId: null, agent: 'coordinator', status: 'active' }],
    );
    assert.equal(await prisma.session.count({ where: { userId: stand.userId } }), 1);
    assert.match(stand.cookie, /^session_id=[A-Za-z0-9_-]+$/);
  });

  test('requests carry the session; without it the api answers 401', async () => {
    const me = await stand.request('GET', '/api/me');

    assert.equal(me.status, 200);
    assert.deepEqual(me.json<MeResponse>(), { userId: stand.userId, workspaceName: null, operatorName: null, mainThreadId: stand.mainThreadId });

    const anonymous = await stand.request('GET', '/api/me', { cookie: null });

    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.json<{ error: { code: string } }>().error.code, 'unauthorized');

    const stranger = await stand.request('GET', '/api/me', { cookie: 'session_id=not-a-session' });

    assert.equal(stranger.status, 401);
  });

  test('a static import of the app ahead of the stand is caught by the stand’s check', async () => {
    // A test file of its own, in a test child of its own (the client of
    // this process already reaches the copy): client.ts is evaluated with
    // the blocked DATABASE_URL before startStand() runs, and the stand's
    // first query names the mistake instead of letting the tests run.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'balabash-stand-order-'));
    const file = path.join(dir, 'order.test.ts');
    const here = path.dirname(new URL(import.meta.url).pathname);

    await fs.writeFile(
      file,
      [
        "import { test } from 'node:test';",
        `import { prisma } from '${path.join(here, '..', 'db', 'client.ts')}';`,
        `import { startStand } from '${path.join(here, 'stand.ts')}';`,
        "test('static import before the stand', async () => { void prisma; await startStand(); });",
        '',
      ].join('\n'),
    );

    // The environment `npm test` gives a child: the blocked DATABASE_URL
    // (not this stand's copy, which the process holds now) and no
    // NODE_TEST_CONTEXT of its own — under an inherited one node's runner
    // takes the nested `--test` for a test child already and runs nothing.
    const { NODE_TEST_CONTEXT: _, ...env } = process.env;

    try {
      const run = await promisify(execFile)(process.execPath, ['--test', '--no-warnings=ExperimentalWarning', file], {
        env: { ...env, DATABASE_URL: BLOCKED_DATABASE_URL },
        timeout: 60_000,
      }).then(
        result => ({ code: 0, ...result }),
        (error: Error & { code?: number; stdout?: string; stderr?: string }) => ({ code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }),
      );
      const output = run.stdout + run.stderr;

      assert.equal(run.code, 1, output);
      assert.match(output, /import the app's modules dynamically after `await startStand\(\)`/);
      assert.match(output, /127\.0\.0\.1:1/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test('a second stand in the same process is refused', async () => {
    await assert.rejects(startStand(), /one stand per test file/);
  });

  test('sessionCookie picks the host-only pair out of the login response', () => {
    const headers = [
      'session_id=abc.def_123; path=/; expires=Thu, 01 Jan 2026 00:00:00 GMT; samesite=lax; secure; httponly',
      'session_id=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT; domain=.console.test; samesite=lax; secure; httponly',
    ];

    assert.equal(sessionCookie(headers), 'session_id=abc.def_123');
    assert.equal(sessionCookie([headers[1]!, headers[0]!]), 'session_id=abc.def_123');
    assert.throws(() => sessionCookie([headers[1]!]), /no session cookie/);
  });
});
