// db/client.ts under node:test: a child that inherits a foreign DATABASE_URL
// (the shell of `npm test` carries the app's) builds its Prisma client on the
// blocked address, so the first query refuses at once and nothing is asked
// of the foreign server. A real child process with the variable set the
// way the shell would set it — the import-time choice is what is under test.
//
// Run: npm test  (node:test, native type stripping — no build needed).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { TEST_PG_ENV } from '../test-support/pg.ts';

const FOREIGN = 'postgresql://user:secret@db.example.invalid:25060/balabash_v2?sslmode=require';

test('a test child with a foreign DATABASE_URL queries the blocked address, not the foreign one', async () => {
  const program = `
    import { prisma } from ${JSON.stringify(new URL('./client.ts', import.meta.url).href)};
    prisma.user.count().then(
      () => { console.log(JSON.stringify({ reached: true })); },
      error => { console.log(JSON.stringify({ code: error.code, message: error.message })); },
    );
  `;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '--no-warnings', '-e', program], {
    env: { ...process.env, DATABASE_URL: FOREIGN, NODE_TEST_CONTEXT: 'child-v8', [TEST_PG_ENV]: '' },
    timeout: 30_000,
  });
  const result = JSON.parse(stdout.trim()) as { reached?: boolean; code?: string; message?: string };

  assert.equal(result.reached, undefined);
  assert.equal(result.code, 'P1001');
  assert.match(result.message ?? '', /127\.0\.0\.1:1\b/);
  assert.doesNotMatch(result.message ?? '', /example\.invalid/);
});
