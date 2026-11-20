// The node `system`, called the way every caller reaches it: through a grant
// and the one path of a call (src/catalog). The stand's process stands in a
// directory of its own, which here plays the root of the repository: the
// bundle and the sources the request looks at are the files the test puts
// there.
//
// Run: npm test  (node:test, native type stripping — no build needed).

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CapabilityError, computeGrant, invokeCapability } from '../catalog/index.ts';
import type { ConnectionsPort, ErrorKind, Grant } from '../catalog/index.ts';
import type { JsonObject } from '../core/contract.ts';
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

let stand: Stand;
let prisma: typeof import('../db/client.ts')['prisma'];
let grant: Grant;

type Value = Record<string, any>;

function invoke(name: string, input: JsonObject): Promise<Value> {
  return invokeCapability(grant, name, input, { connections: NO_CONNECTIONS }) as Promise<Value>;
}

async function refuses(call: Promise<unknown>, kind: ErrorKind, message: RegExp): Promise<void> {
  await assert.rejects(call, (error: unknown) => {
    assert.ok(error instanceof CapabilityError, `a CapabilityError, got ${String(error)}`);
    assert.equal(error.kind, kind, error.message);
    assert.match(error.message, message);

    return true;
  });
}

// A file of the stand's directory, last changed `secondsAgo`.
async function put(relPath: string, secondsAgo: number): Promise<void> {
  const file = path.join(stand.dir, relPath);
  const changed = new Date(Date.now() - secondsAgo * 1000);

  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, '// a file\n');
  await fs.utimes(file, changed, changed);

  // A folder is as new as the last entry made in it: the folders of the
  // path, just written into, take the time of the file.
  for (let folder = path.dirname(file); folder !== stand.dir; folder = path.dirname(folder)) {
    await fs.utimes(folder, changed, changed);
  }
}

async function requests() {
  const rows = await prisma.event.findMany({ where: { type: 'system.restart.requested' }, orderBy: { seq: 'asc' } });

  return rows.map(row => ({ actor: row.actor, workspaceId: row.workspaceId, threadId: row.threadId, payload: row.payload }));
}

before(async () => {
  stand = await startStand();
  ({ prisma } = await import('../db/client.ts'));

  const tree = await import('./index.ts');

  grant = await computeGrant(
    tree.catalog(),
    { allows: () => true, actions: ['describe', 'call'] },
    { caller: { workspaceId: stand.workspaceId, threadId: stand.mainThreadId, agentName: 'engineer' }, connections: NO_CONNECTIONS },
  );
});

after(() => stand.stop());

describe('system_request_restart', () => {
  test('without a built bundle the restart is not registered', async () => {
    await put('src/app.ts', 60);

    await refuses(invoke('system_request_restart', { reason: 'A fix of the router.' }), 'conflict', /^There is no built bundle \(dist\/app\.js\), so the restart is not registered: build the app/);
    assert.deepEqual(await requests(), []);
  });

  test('the request is an event of the log on behalf of the calling thread; the value says whether the bundle is as new as the sources', async () => {
    await put('dist/app.js', 30);

    assert.deepEqual(await invoke('system_request_restart', { reason: '  A fix of the router.  ' }), { build: 'current' });
    assert.deepEqual(await requests(), [
      { actor: 'system', workspaceId: stand.workspaceId, threadId: stand.mainThreadId, payload: { reason: 'A fix of the router.', requestedBy: 'engineer' } },
    ]);

    // A source changed after the build: the restart is registered all the
    // same, and boots the bundle as it is.
    await put('agents/world/new.ts', 5);

    assert.deepEqual(await invoke('system_request_restart', { reason: 'Built before the last edit.' }), { build: 'stale' });
    assert.deepEqual((await requests())[1]?.payload, { reason: 'Built before the last edit.', requestedBy: 'engineer' });
  });

  test('a restart requested by a scheduled task records the task and run in the envelope', async () => {
    await put('dist/app.js', 1);
    const program = { task: 'maintenance', runId: 'restart-run', ended: new AbortController().signal };
    await invokeCapability(grant, 'system_request_restart', { reason: 'Bundle rebuilt.' }, { connections: NO_CONNECTIONS, program });
    const row = await prisma.event.findFirstOrThrow({ where: { type: 'system.restart.requested' }, orderBy: { seq: 'desc' } });
    assert.deepEqual([row.actor, row.agentName, row.taskSlug, row.taskRunId], ['task', null, program.task, program.runId]);
    assert.deepEqual(row.payload, { reason: 'Bundle rebuilt.', requestedBy: 'task maintenance' });
  });

  test('accepts only a nonblank reason', async () => {
    const before = (await requests()).length;

    await refuses(invoke('system_request_restart', { reason: '   ' }), 'invalid_input', /^reason is blank/);
    await refuses(invoke('system_request_restart', { reason: '' }), 'invalid_input', /system_request_restart/);
    await refuses(invoke('system_request_restart', {}), 'invalid_input', /system_request_restart/);
    await refuses(invoke('system_request_restart', { reason: 'Rebuilt.', force: true }), 'invalid_input', /system_request_restart/);
    assert.equal((await requests()).length, before);
  });
});

test('the built-in request_restart offers only the reason and records the request for its thread', async () => {
  const { createRestartToolServer } = await import('../capabilities/restart-tools.ts');
  const server = createRestartToolServer();
  const [tool] = await server.getFunctions(stand.workspaceId);

  assert.equal(tool?.functionName, 'request_restart');
  assert.deepEqual(Object.keys(tool.inputSchema.properties as object), ['reason']);
  assert.equal(tool.inputSchema.additionalProperties, false);

  const reason = 'Activate the rebuilt app.';
  const reply = await server.call('request_restart', { reason }, { workspaceId: stand.workspaceId, threadId: stand.mainThreadId });

  assert.match(String(reply), /End your turn/);
  assert.deepEqual((await requests()).at(-1), {
    actor: 'system', workspaceId: stand.workspaceId, threadId: stand.mainThreadId, payload: { reason, requestedBy: 'coordinator' },
  });
});

describe('the state of the bundle', () => {
  test('is read at the root it is asked about: missing, current, or stale by the newest file anywhere in the sources', async () => {
    const { bundleState } = await import('../runtime/bundle.ts');
    const root = path.join(stand.dir, 'elsewhere');
    const at = (relPath: string, secondsAgo: number) => put(path.join('elsewhere', relPath), secondsAgo);

    await at('src/core/deep/module.ts', 600);
    await at('package.json', 600);
    assert.equal(await bundleState(root), 'missing');

    await at('dist/app.js', 300);
    assert.equal(await bundleState(root), 'current');

    // What the bundle is not built from does not make it stale.
    await at('data/notes.md', 1);
    await at('dist/console/app.js', 1);
    assert.equal(await bundleState(root), 'current');

    await at('src/core/deep/module.ts', 100);
    assert.equal(await bundleState(root), 'stale');

    await at('dist/app.js', 50);
    assert.equal(await bundleState(root), 'current');

    await at('package.json', 10);
    assert.equal(await bundleState(root), 'stale');
  });

  test('the console is a bundle of its own: its sources do not make the app\'s bundle stale; a folder under the name of the bundle is no bundle', async () => {
    const { bundleState } = await import('../runtime/bundle.ts');
    const root = path.join(stand.dir, 'apart');
    const at = (relPath: string, secondsAgo: number) => put(path.join('apart', relPath), secondsAgo);

    await at('src/app.ts', 600);
    await at('dist/app.js', 300);
    await at('src/console/pages/threads.tsx', 1);
    // The folder src itself is as old as its last own entry.
    await fs.utimes(path.join(root, 'src'), new Date(Date.now() - 600_000), new Date(Date.now() - 600_000));
    assert.equal(await bundleState(root), 'current');

    await at('src/api/console.ts', 1);
    assert.equal(await bundleState(root), 'stale');

    await fs.rm(path.join(root, 'dist', 'app.js'));
    await fs.mkdir(path.join(root, 'dist', 'app.js'));
    assert.equal(await bundleState(root), 'missing');
  });
});
