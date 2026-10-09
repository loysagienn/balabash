// db/client.ts at import, in a real child process with the variables set the
// way a shell would set them — the import-time choice is what is under test.
// Under node:test a child that inherits a foreign DATABASE_URL (the shell of
// `npm test` carries the app's) builds its Prisma client on the blocked
// address, so the first query refuses at once and nothing is asked of the
// foreign server. Outside node:test the config's own requirement holds: an
// empty DATABASE_URL is "not set" and the import throws, as it always did.
//
// Run: npm test  (node:test, native type stripping — no build needed).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { TEST_PG_ENV } from '../test-support/pg.ts';

const FOREIGN = 'postgresql://user:secret@db.example.invalid:25060/balabash_v2?sslmode=require';

const program = `
  import { prisma } from ${JSON.stringify(new URL('./client.ts', import.meta.url).href)};
  prisma.user.count().then(
    () => { console.log(JSON.stringify({ reached: true })); },
    error => { console.log(JSON.stringify({ code: error.code, message: error.message })); },
  );
`;

async function run(env: Record<string, string | undefined>): Promise<{ stdout: string; stderr: string; failed: boolean }> {
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, ['--input-type=module', '--no-warnings', '-e', program], {
      env: { ...process.env, ...env, [TEST_PG_ENV]: '' },
      timeout: 30_000,
    });
    return { stdout, stderr, failed: false };
  } catch (error) {
    const { stdout = '', stderr = '' } = error as { stdout?: string; stderr?: string };
    return { stdout, stderr, failed: true };
  }
}

test('a test child with a foreign DATABASE_URL queries the blocked address, not the foreign one', async () => {
  const { stdout, failed } = await run({ DATABASE_URL: FOREIGN, NODE_TEST_CONTEXT: 'child-v8' });
  const result = JSON.parse(stdout.trim()) as { reached?: boolean; code?: string; message?: string };

  assert.equal(failed, false);
  assert.equal(result.reached, undefined);
  assert.equal(result.code, 'P1001');
  assert.match(result.message ?? '', /127\.0\.0\.1:1\b/);
  assert.doesNotMatch(result.message ?? '', /example\.invalid/);
});

test('outside node:test an empty DATABASE_URL is refused at import by the config, nothing is dialed', async () => {
  const { stdout, stderr, failed } = await run({ DATABASE_URL: '', NODE_TEST_CONTEXT: undefined });

  assert.equal(failed, true);
  assert.equal(stdout.trim(), '');
  assert.match(stderr, /DATABASE_URL is not set/);
});
