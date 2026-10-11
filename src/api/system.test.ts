// GET /api/system over the stand (src/test-support/stand.ts): the machine
// read from the kernel, the process's own facts, the database by its size
// read, the file area of the session's workspace once walked, the restart
// in the way; and the system log of the snapshot — the newest system.*
// events the stream would show this workspace, in seq order, which the
// console's system domain reproduces from the tail.
//
// Run: npm test

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { startStand } from '../test-support/stand.ts';
import type { Stand } from '../test-support/stand.ts';
import type { SnapshotResponse, SystemResponse } from './contract.ts';
import { eventAction } from '../console/store/events.ts';
import { snapshot as snapshotFixture } from '../console/store/fixtures.ts';
import { initialSystem, systemReducer } from '../console/store/system/reducer.ts';
import { snapshotLoadDone } from '../console/store/stream/actions.ts';

let stand: Stand;
let prisma: typeof import('../db/client.ts')['prisma'];
let appendEvent: typeof import('../core/append.ts')['appendEvent'];
let measureFileAreaTotals: typeof import('../workspace/totals.ts')['measureFileAreaTotals'];
let readSystemLog: typeof import('./snapshot.ts')['readSystemLog'];
let getEventsAfter: typeof import('../core/events.ts')['getEventsAfter'];

before(async () => {
  stand = await startStand();
  // The snapshot's agent catalog names the coordinator's model from the
  // config (src/api/snapshot.ts coordinatorView); the stand strips it.
  process.env.MAIN_OPENAI_MODEL = 'gpt-5.2';
  ({ prisma } = await import('../db/client.ts'));
  ({ appendEvent } = await import('../core/append.ts'));
  ({ measureFileAreaTotals } = await import('../workspace/totals.ts'));
  ({ readSystemLog } = await import('./snapshot.ts'));
  ({ getEventsAfter } = await import('../core/events.ts'));
});

after(async () => {
  delete process.env.MAIN_OPENAI_MODEL;
  await stand.stop();
});

describe('GET /api/system', () => {
  test('answers the machine, the process, the database and no file area before a walk; signed out it is a 401', async () => {
    const reply = await stand.request('GET', '/api/system');

    assert.equal(reply.status, 200, reply.text);

    const body = reply.json<SystemResponse>();

    assert.ok(body.at instanceof Date);
    assert.ok(body.machine.uptimeSeconds > 0);
    assert.ok(body.machine.cpu.cores >= 1);
    assert.equal(body.machine.cpu.loadAvg.length, 3);
    assert.ok(body.machine.memory === null || body.machine.memory.totalBytes > body.machine.memory.usedBytes);
    assert.ok(body.machine.disk === null || body.machine.disk.totalBytes >= body.machine.disk.usedBytes);
    assert.equal(body.process.pid, process.pid);
    assert.equal(body.process.node, process.version);
    assert.ok(body.process.startedAt instanceof Date);
    assert.ok(body.process.uptimeSeconds > 0);
    assert.ok(body.process.rssBytes > 0);
    assert.deepEqual({ sessions: body.process.liveSessions, jobs: body.process.workspaceJobs }, { sessions: 0, jobs: 0 });
    assert.equal(body.database.available, true);
    assert.ok((body.database.sizeBytes ?? 0) > 0);
    assert.equal(body.database.error, null);
    assert.equal(body.fileStorageBytes, 0);
    assert.equal(body.fileArea, null);
    assert.deepEqual(body.restart, { pending: null });

    assert.equal((await stand.request('GET', '/api/system', { cookie: null })).status, 401);
  });

  test('answers the file area of the session’s workspace once walked, per top-level folder too', async () => {
    const filesDir = (await import('../workspace/layout.ts')).workspaceFilesDir(stand.userId);

    await fs.mkdir(path.join(filesDir, 'renovation'), { recursive: true });
    await fs.writeFile(path.join(filesDir, 'notes.md'), 'abc');
    await fs.writeFile(path.join(filesDir, 'renovation', 'AGENTS.md'), '1234');
    await measureFileAreaTotals(stand.userId);

    const body = (await stand.request('GET', '/api/system')).json<SystemResponse>();

    assert.ok(body.fileArea);
    assert.ok(body.fileArea.measuredAt instanceof Date);
    assert.deepEqual({ files: body.fileArea.files, bytes: body.fileArea.bytes, folders: body.fileArea.folders, complete: body.fileArea.complete }, { files: 2, bytes: 7, folders: { renovation: { files: 1, bytes: 4 } }, complete: true });
  });
});

describe('the system log of the snapshot', () => {
  const headSeq = async () => (await prisma.event.aggregate({ _max: { seq: true } }))._max.seq ?? 0n;

  test('carries this workspace’s and the installation’s system events in seq order, never another workspace’s', async () => {
    const foreign = randomUUID();

    await appendEvent({ type: 'system.restart.requested', actor: 'system', userId: stand.userId, threadId: stand.mainThreadId, payload: { reason: 'a new build', requestedBy: 'engineer' } });
    await appendEvent({ type: 'system.exception', actor: 'system', userId: null, payload: { scope: 'migrate-deploy', error: 'migration 0041 failed' } });
    await appendEvent({ type: 'system.exception', actor: 'system', userId: foreign, payload: { scope: 'workspace-job', slug: 'elsewhere', error: 'not ours' } });
    await appendEvent({ type: 'system.restart.completed', actor: 'system', userId: stand.userId, threadId: null, targetThreadId: stand.mainThreadId, payload: { reason: 'a new build', requestSeq: 1 } });

    const snapshot = (await stand.request('GET', '/api/snapshot')).json<SnapshotResponse>();
    const log = snapshot.systemLog;

    assert.deepEqual(
      log.map(event => [event.type, event.userId]),
      [
        ['system.restart.requested', stand.userId],
        ['system.exception', null],
        ['system.restart.completed', stand.userId],
      ],
    );
    assert.ok(log.every((event, i) => i === 0 || event.seq > log[i - 1].seq));
    assert.equal(log[0].payload.requestedBy, 'engineer');
  });

  test('the replay of the tail over the snapshot equals the next snapshot', async () => {
    const asOfSeq = await headSeq();
    const hydrated = await readSystemLog(stand.userId);

    await appendEvent({ type: 'system.restart.requested', actor: 'system', userId: stand.userId, threadId: stand.mainThreadId, payload: { reason: 'another build' } });
    await appendEvent({ type: 'user.message', actor: 'user', userId: stand.userId, threadId: stand.mainThreadId, payload: { text: 'not a system event', source: 'web' } });
    await appendEvent({ type: 'system.exception', actor: 'system', userId: randomUUID(), payload: { error: 'another workspace' } });
    await appendEvent({ type: 'system.exception', actor: 'system', userId: null, payload: { scope: 'supervisor-rollback', error: 'rolled back' } });

    // The tail as the stream serves it: this workspace's events after the stamp.
    const tail = (await getEventsAfter(asOfSeq, { limit: 1000 })).filter(event => event.userId === stand.userId || event.userId === null);
    let state = systemReducer(initialSystem, snapshotLoadDone(snapshotFixture({ asOfSeq, systemLog: hydrated })));

    for (const event of tail) {
      state = systemReducer(state, eventAction(event));
    }

    const next = await readSystemLog(stand.userId);

    assert.equal(next.length, hydrated.length + 2);
    assert.deepEqual(
      state.log.map(event => [event.seq, event.type]),
      next.map(event => [event.seq, event.type]),
    );
  });
});
