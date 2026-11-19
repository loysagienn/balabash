// A program over the tree of Balabash: the runner of the catalog
// (src/catalog/program.ts) with the real capabilities behind `call` — the
// file area, the database and the commands of the stand's workspace. What a
// program is and how each way of ending comes back is checked on the
// catalog's own tree; here is what holds only with real actions: a chain
// over the workbench, a failed command as an error the program may catch,
// and a command that does not outlive the run that started it.
//
// Run: npm test  (node:test, native type stripping — no build needed).

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CapabilityError, computeGrant, executeProgram, runProgram } from '../catalog/index.ts';
import type { ConnectionsPort, Grant } from '../catalog/index.ts';
import { startStand } from '../test-support/stand.ts';
import type { Stand } from '../test-support/stand.ts';

const NO_CONNECTIONS: ConnectionsPort = {
  accounts: async () => [],
  secretsReady: async () => false,
};

const env = { connections: NO_CONNECTIONS };

let stand: Stand;
let tree: typeof import('./index.ts');
let grant: Grant;
let area: string;

before(async () => {
  stand = await startStand();
  tree = await import('./index.ts');
  grant = await computeGrant(
    tree.catalog(),
    { allows: () => true, actions: ['describe', 'call', 'run_program'] },
    { caller: { workspaceId: stand.workspaceId, threadId: stand.mainThreadId, agentName: 'tester' }, connections: NO_CONNECTIONS },
  );
  area = path.join(stand.dir, 'data', 'workspace', stand.workspaceId, 'files');
});

after(() => stand.stop());

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);

    return true;
  } catch {
    return false;
  }
}

async function until(condition: () => boolean | Promise<boolean>, withinMs: number): Promise<boolean> {
  for (const started = Date.now(); Date.now() - started < withinMs; ) {
    if (await condition()) {
      return true;
    }

    await new Promise(resolve => setTimeout(resolve, 25));
  }

  return false;
}

describe('a program over the tree', () => {
  test('chains the workbench: a file, a command over it, the database — and returns one value', async () => {
    const value = await runProgram(
      grant,
      {
        code: `
          await call('workspace_files_write', { path: 'report/numbers.txt', content: '3\\n4\\n5\\n' });
          const sum = await call('workspace_run_command', { command: "paste -sd+ report/numbers.txt | bc" });
          await call('workspace_query', { sql: 'CREATE TABLE IF NOT EXISTS sums (value INTEGER); INSERT INTO sums VALUES (' + Number(sum.stdout) + ')' });
          const read = await call('workspace_query', { sql: 'SELECT value FROM sums' });
          const leaf = await describe('workspace_query');
          return { rows: read.rows, described: leaf.name };
        `,
      },
      env,
    );

    assert.deepEqual(value, { rows: [{ value: 12 }], described: 'workspace_query' });
    assert.equal(await fs.readFile(path.join(area, 'report/numbers.txt'), 'utf8'), '3\n4\n5\n');
  });

  test('gets a failed command as an error with the exit code and the output, and fails with it when it does not catch it', async () => {
    const caught = await runProgram(
      grant,
      {
        code: `
          try {
            await call('workspace_run_command', { command: 'echo partial; exit 3' });
          } catch (error) {
            return { kind: error.kind, exitCode: error.details.exitCode, stdout: error.details.stdout };
          }
        `,
      },
      env,
    );

    assert.deepEqual(caught, { kind: 'external_error', exitCode: 3, stdout: 'partial\n' });

    await assert.rejects(runProgram(grant, { code: `await call('workspace_run_command', { command: 'exit 4' }); return null;` }, env), (error: unknown) => {
      assert.ok(error instanceof CapabilityError);
      assert.equal(error.kind, 'external_error');
      assert.equal((error.details as { exitCode: number }).exitCode, 4);

      return true;
    });
  });

  test('out of time takes its command with it: the process group of the command is gone', async () => {
    const run = await executeProgram(
      grant,
      { code: `await call('workspace_run_command', { command: 'echo $$ > command.pid; sleep 60 & wait', timeoutSeconds: 120 });`, timeoutMs: 700 },
      env,
    );

    assert.equal(run.outcome, 'timeout');
    assert.deepEqual(run.error?.details, { unfinishedCalls: ['workspace_run_command'] });

    const pid = Number(await fs.readFile(path.join(area, 'command.pid'), 'utf8'));

    assert.ok(pid > 0);
    assert.ok(await until(() => !alive(pid), 3_000), 'the shell of the command is gone');
    assert.ok(await until(() => !tree.hasRunningWork(), 3_000), 'nothing of the scheme is left running');
  });

  test('stopped with everything else the scheme runs, ends as aborted and leaves no command behind', async () => {
    const program = executeProgram(
      grant,
      { code: `await call('workspace_run_command', { command: 'echo $$ > stopped.pid; sleep 60', timeoutSeconds: 120 });`, timeoutMs: 60_000 },
      env,
    );

    assert.ok(await until(() => fs.stat(path.join(area, 'stopped.pid')).then(() => true, () => false), 5_000));
    assert.equal(tree.hasRunningWork(), true);
    tree.stopRunningWork();

    const run = await program;
    const pid = Number(await fs.readFile(path.join(area, 'stopped.pid'), 'utf8'));

    assert.equal(run.outcome, 'aborted');
    assert.ok(await until(() => !alive(pid), 3_000));
    assert.ok(await until(() => !tree.hasRunningWork(), 3_000));
  });
});
