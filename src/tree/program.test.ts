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
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { sweepProcessGroups } from '../runtime/process-groups.ts';
import { CapabilityError, computeGrant, executeProgram, invokeCapability, runProgram } from '../catalog/index.ts';
import type { ConnectionsPort, Grant } from '../catalog/index.ts';
import { startStand } from '../test-support/stand.ts';
import type { Stand } from '../test-support/stand.ts';

const NO_CONNECTIONS: ConnectionsPort = {
  accounts: async () => [],
  secretsReady: async () => false,
  accountAuthority: async () => {
    throw new Error('no account is connected');
  },
  secretAuthority: async () => {
    throw new Error('no secret is entered');
  },
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
    assert.deepEqual(await fs.readdir('data/process-groups'), []);
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

  test('a registration failure keeps both program and command bodies from starting', async () => {
    const dir = 'data/process-groups';
    await fs.rm(dir, { recursive: true, force: true });
    await fs.writeFile(dir, 'occupied');
    try {
      const command = { command: 'touch unregistered' };
      await assert.rejects(invokeCapability(grant, 'workspace_run_command', command, env), /process-groups/);
      const run = await executeProgram(grant, { code: "return 'executed';", timeoutMs: 5_000 }, env);
      assert.equal(run.outcome, 'failed');
      assert.match(run.error!.message, /process-groups/);
      await assert.rejects(fs.stat(path.join(area, 'unregistered')), { code: 'ENOENT' });
    } finally {
      await fs.unlink(dir);
      await fs.mkdir(dir);
    }
  });

  test('a stale record for a live group with another boot or start time leaves it running', async () => {
    const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
    const exited = once(child, 'exit');
    try {
      const boot = (await fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
      const stat = await fs.readFile(`/proc/${child.pid}/stat`, 'utf8');
      const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
      await fs.mkdir('data/process-groups', { recursive: true });
      await fs.writeFile(`data/process-groups/${boot}.${child.pid}.${BigInt(start) + 1n}`, '');
      await fs.writeFile(`data/process-groups/00000000-0000-0000-0000-000000000000.${child.pid}.${start}`, '');
      sweepProcessGroups();
      assert.deepEqual(await fs.readdir('data/process-groups'), []);
      child.kill('SIGTERM');
      assert.deepEqual(await exited, [null, 'SIGTERM']);
    } finally {
      child.kill('SIGKILL');
      await exited;
    }
  });

  test('boot kills a busy program and a leaderless command group left by a crashed app', async () => {
    const owner = spawn(process.execPath, [
      fileURLToPath(new URL('../test-support/process-group-owner.ts', import.meta.url)), stand.workspaceId, stand.mainThreadId,
    ], { stdio: 'inherit' });
    const exited = once(owner, 'exit');
    const registry = 'data/process-groups';
    try {
      const pids = path.join(area, 'crash.pids');
      assert.ok(await until(() => fs.stat(pids).then(() => true, () => false), 10_000));
      const [shell, sleep] = (await fs.readFile(pids, 'utf8')).trim().split(' ').map(Number);
      assert.ok(await until(() => !alive(shell), 3_000), 'the shell has been reaped');
      const groups = (await fs.readdir(registry)).map(name => Number(name.split('.')[1]));
      assert.equal(groups.length, 2);
      assert.ok(groups.includes(shell));
      const program = groups.find(pid => pid !== shell)!;

      owner.kill('SIGKILL');
      await exited;
      assert.ok(alive(program) && alive(sleep));
      sweepProcessGroups();

      // An orphan may still be a zombie until the host reaps it.
      const stopped = (pid: number) => fs.readFile(`/proc/${pid}/stat`, 'utf8').then(
        stat => stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z '),
        (error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT' || error.code === 'ESRCH') return true;
          throw error;
        },
      );
      assert.ok(await until(async () => await stopped(program) && await stopped(sleep), 3_000));
      assert.deepEqual(await fs.readdir(registry), []);
      sweepProcessGroups();
    } finally {
      owner.kill('SIGKILL');
      await exited;
      sweepProcessGroups();
    }
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
