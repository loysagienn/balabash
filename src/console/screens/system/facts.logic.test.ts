import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { event, resetSeq } from '../../store/fixtures.ts';
import {
  consumerWords,
  cpuAverage,
  cpuWords,
  diskConsumers,
  diskWords,
  emptyLogWords,
  fileAreaSummary,
  filteredRows,
  logRows,
  memoryWords,
  networkWords,
  pendingOf,
  processUptimeWords,
  restartNote,
  restartRows,
  sessionsWords,
  sparkOf,
  systemSummary,
  tookLabel,
  trafficCaption,
  updatedWords,
  uptimeLabel,
  versionWords,
} from './facts.logic.ts';

const at = (y: number, m: number, d: number, h = 0, min = 0, s = 0) => new Date(y, m - 1, d, h, min, s);
const NOW = at(2026, 10, 11, 16, 38);
const GB = 1_000_000_000;

describe('the machine', () => {
  it('names the cores and the load, the memory and the swap, the disk and what is free, the traffic', () => {
    assert.deepEqual(cpuWords({ cores: 8, perCore: null, loadAvg: [0.42, 0.51, 0.48] }), { title: 'CPU · 8 cores', load: 'load 0.42 · 0.51 · 0.48' });
    assert.equal(cpuAverage([22, 9, 31, 6]), 17);
    assert.equal(cpuAverage(null), null);
    assert.equal(cpuAverage([]), null);
    assert.deepEqual(memoryWords({ totalBytes: 16 * GB, usedBytes: 9.8 * GB, swapTotalBytes: 8 * GB, swapUsedBytes: 0.3 * GB }), { percent: 61.25, main: '9.8 of 16 GB', swap: 'swap 4% · 0.3 of 8 GB' });
    assert.equal(memoryWords({ totalBytes: 4 * GB, usedBytes: GB, swapTotalBytes: 0, swapUsedBytes: 0 }).swap, 'no swap');
    assert.deepEqual(diskWords({ totalBytes: 200 * GB, usedBytes: 131 * GB, freeBytes: 69 * GB }), { percent: 65.5, main: '131 of 200 GB · 69 GB free' });
    assert.equal(networkWords({ inBytesPerSecond: 1_200_000, outBytesPerSecond: 300_000, inboundPerMinute: [] }), 'in 1.2 MB/s · out 300 KB/s');
    assert.equal(networkWords({ inBytesPerSecond: null, outBytesPerSecond: null, inboundPerMinute: [] }), 'measuring the rate…');
  });

  it('scales the spark to its largest bar and captions the hour', () => {
    assert.deepEqual(sparkOf([20, 50, 100, 0]), [20, 50, 100, 0]);
    assert.deepEqual(sparkOf([0, 0]), [0, 0]);
    assert.deepEqual(sparkOf([]), []);
    assert.equal(trafficCaption(60), 'inbound traffic · last hour');
    assert.equal(trafficCaption(7), 'inbound traffic · last 7 min');
    assert.equal(trafficCaption(1), null);
  });

  it('names the consumers of the disk, with a walk still to come', () => {
    assert.equal(consumerWords(41 * GB), '41 GB');
    assert.equal(consumerWords(null, true), 'measuring…');
    assert.equal(consumerWords(null), '—');
    assert.equal(uptimeLabel(12 * 86_400 + 4 * 3600 + 7 * 60), '12d 4h');
    assert.equal(uptimeLabel(42 * 60), '42m');
  });

  it('lists what is of this volume under the disk and names the database and a Spaces storage apart', () => {
    const area = { measuredAt: NOW, files: 9, bytes: 18 * GB, folders: {}, complete: true, unreadable: 0 };
    const database = { available: true, sizeBytes: 2.4 * GB, error: null, local: false };

    assert.deepEqual(diskConsumers({ fileArea: area, fileStorage: { kind: 'local', bytes: 41 * GB }, database }), {
      items: [
        { key: 'file area · this workspace', value: '18 GB' },
        { key: 'file storage · local', value: '41 GB' },
      ],
      elsewhere: 'outside the breakdown: database 2.4 GB (remote PostgreSQL)',
    });
    assert.deepEqual(diskConsumers({ fileArea: { ...area, complete: false, unreadable: 1 }, fileStorage: { kind: 'spaces', bytes: 41 * GB }, database: { ...database, local: true } }), {
      items: [{ key: 'file area · this workspace', value: 'at least 18 GB' }],
      elsewhere: 'outside the breakdown: file storage 41 GB (Spaces) · database 2.4 GB (PostgreSQL on this host)',
    });
    // Before the walk, without the sizes; and the answer of an older server, which names the storage's bytes alone.
    assert.deepEqual(diskConsumers({ fileArea: null, fileStorage: { kind: 'local', bytes: null }, database: { available: false, sizeBytes: null, error: 'down', local: false } }).items, [
      { key: 'file area · this workspace', value: 'measuring…' },
      { key: 'file storage · local', value: '—' },
    ]);
    assert.deepEqual(diskConsumers({ fileArea: null, fileStorage: undefined as never, database: { available: true, sizeBytes: GB, error: null, local: undefined as never } }), {
      items: [
        { key: 'file area · this workspace', value: 'measuring…' },
        { key: 'file storage', value: '—' },
      ],
      elsewhere: 'outside the breakdown: database 1 GB (PostgreSQL)',
    });
  });
});

describe('the process', () => {
  it('says the uptime since the start, the sessions and the jobs, the moment of the facts', () => {
    assert.equal(processUptimeWords(at(2026, 10, 11, 0, 21), NOW), '16h 17m · since 00:21');
    assert.equal(processUptimeWords(at(2026, 10, 8, 0, 21), NOW), '3d 16h · since Oct 8, 00:21');
    assert.equal(sessionsWords({ liveSessions: 4, workspaceJobs: 1 }), '4 live · 1 workspace job');
    assert.equal(sessionsWords({ liveSessions: 0, workspaceJobs: 0 }), '0 live · 0 workspace jobs');
    assert.equal(updatedWords(at(2026, 10, 11, 16, 38).getTime(), 10_000), 'updated 16:38 · every 10s');
    assert.equal(updatedWords(0, 10_000), null);
  });

  it('names the build the process runs, dirty or not, and the checkout when it is another commit', () => {
    const built = at(2026, 10, 11, 15, 50);
    const stamp = { commit: 'eac52f1', branch: 'main', dirty: false, builtAt: built, checkout: { commit: 'eac52f1', branch: 'main' } };

    assert.deepEqual(versionWords(stamp, NOW), { build: 'eac52f1', details: 'main · built 15:50', checkout: null });
    // Built before the commit: the tree was dirty, and the process started in the next commit's checkout.
    assert.deepEqual(versionWords({ ...stamp, dirty: true, checkout: { commit: '7b15d2d', branch: 'main' } }, NOW), { build: 'eac52f1+', details: 'main · built 15:50', checkout: '7b15d2d · main' });
    // A rolled-back bundle: the checkout is ahead of the code running.
    assert.deepEqual(versionWords({ ...stamp, checkout: { commit: '9c0ffee', branch: null } }, NOW).checkout, '9c0ffee');
    // No stamp (the code runs from its sources): the checkout is all there is.
    assert.deepEqual(versionWords({ commit: null, branch: null, dirty: false, builtAt: null, checkout: { commit: '7b15d2d', branch: 'main' } }, NOW), { build: null, details: null, checkout: '7b15d2d · main' });
    assert.deepEqual(versionWords({ commit: null, branch: null, dirty: false, builtAt: null, checkout: null }, NOW), { build: null, details: null, checkout: null });
    // The answer of an older server: commit and branch alone.
    assert.deepEqual(versionWords({ commit: '3f9c21e', branch: 'main' } as never, NOW), { build: '3f9c21e', details: 'main', checkout: null });
  });
});

describe('the restart in the way', () => {
  const request = { requestedBy: 'engineer', requestedAt: at(2026, 10, 11, 16, 5), force: false, own: true };
  const waiting = { threads: [], otherThreads: 0, secretaryTurn: false, workspaceJob: false, logQuiet: true };

  it('names who asked and what the window waits for, this workspace’s threads last as links', () => {
    const threads = [{ id: 't1', title: 'Web UI: screens', agent: 'engineer' }];

    assert.deepEqual(restartNote(request, { ...waiting, threads }, NOW), { lead: 'Requested by engineer at 16:05', threads, tail: ' · waiting for 1 thread to close:' });
    assert.deepEqual(restartNote(request, { ...waiting, secretaryTurn: true, workspaceJob: true, logQuiet: false }, NOW).tail, ' · waiting for a secretary turn to end, a workspace job to end, the log to go quiet');
    assert.deepEqual(restartNote(request, { ...waiting, threads, otherThreads: 2, logQuiet: false }, NOW).tail, ' · waiting for the log to go quiet, 2 threads of other workspaces to close, 1 thread to close:');
    assert.deepEqual(restartNote(request, waiting, NOW).tail, ' · restarting now');
    assert.deepEqual(restartNote({ ...request, requestedBy: null, force: true }, undefined, NOW), { lead: 'Requested by the operator at 16:05 · force', threads: [], tail: ' · checking the safe window' });
    assert.equal(restartNote(request, null, NOW).tail, ' · checking the safe window');
    // Another workspace's request: no requester to name, its threads a count.
    assert.deepEqual(restartNote({ ...request, requestedBy: null, own: false }, { ...waiting, otherThreads: 1 }, NOW), { lead: 'Requested from another workspace at 16:05', threads: [], tail: ' · waiting for 1 thread of other workspaces to close' });
  });

  it('is the facts’ pending unless the log completed it, else the log’s newest request after its newest completion', () => {
    resetSeq();

    const requested = (seq: bigint) => event({ seq, type: 'system.restart.requested', actor: 'system', threadId: 't1', createdAt: request.requestedAt, payload: { reason: 'a build', requestedBy: 'engineer' } });
    const completed = (seq: bigint, requestSeq: number) => event({ seq, type: 'system.restart.completed', actor: 'system', targetThreadId: 'main', payload: { reason: 'a build', requestSeq } });
    const pending = { seq: 7, own: true, reason: 'a build', requestedAt: request.requestedAt, requestedBy: 'engineer', threadId: 't1', force: false, waiting };

    // The facts name the request the log holds: the facts, with the window.
    assert.deepEqual(pendingOf([requested(7n)], pending), { request, waiting });
    // The request left the log behind fifty exceptions: the facts still say it.
    const exceptions = Array.from({ length: 50 }, (_, i) => event({ seq: BigInt(10 + i), type: 'system.exception', actor: 'system', payload: { error: 'x' } }));

    assert.deepEqual(pendingOf(exceptions, pending), { request, waiting });
    // The log holds a completion past it: the facts are from before that restart.
    assert.equal(pendingOf([requested(7n), completed(9n, 7)], pending), null);
    // The facts did not answer, or answered before the request: the log's request, the window unknown.
    assert.deepEqual(pendingOf([requested(7n)], undefined), { request, waiting: undefined });
    assert.deepEqual(pendingOf([requested(7n)], null), { request, waiting: undefined });
    // Another workspace's request, which the log never shows.
    assert.deepEqual(pendingOf([], { ...pending, own: false, reason: null, requestedBy: null, threadId: null }), { request: { ...request, requestedBy: null, own: false }, waiting });
    // A pending of an older server, without a seq: left to the log.
    assert.equal(pendingOf([completed(9n, 7)], { ...pending, seq: undefined as never }), null);
    assert.equal(pendingOf([], null), null);
  });
});

describe('the rows of the log', () => {
  const requested = (seq: bigint, time: Date, requestedBy: string | null = 'engineer') => event({ seq, type: 'system.restart.requested', actor: 'system', threadId: 't1', createdAt: time, payload: { reason: 'Console cycle 55: the System screen', ...(requestedBy ? { requestedBy } : {}) } });
  const completed = (seq: bigint, time: Date, requestSeq: number, extra: Record<string, unknown> = {}) => event({ seq, type: 'system.restart.completed', actor: 'system', targetThreadId: 'main', createdAt: time, payload: { reason: 'Console cycle 55: the System screen', requestSeq, ...extra } });

  it('reads a completion with its request: who asked, how long it took, what broke', () => {
    resetSeq();

    const log = [requested(3n, at(2026, 10, 11, 16, 5)), completed(5n, at(2026, 10, 11, 16, 5, 38), 3), completed(8n, at(2026, 10, 11, 17, 0), 7, { rolledBack: true, rollbackReason: 'crash-loop' }), completed(9n, at(2026, 10, 11, 18, 0), 3, { migrationsFailed: ['0041_app_slug'] })];
    const rows = logRows(log);

    assert.deepEqual(
      rows.map(row => [row.seq, row.kind, row.icon, row.state, row.title, row.meta, row.status, row.sub, row.threadId]),
      [
        [9n, 'restart', 'rotate-cw', 'err', 'Restart · Console cycle 55: the System screen', 'requested by engineer · migrations failed: 0041_app_slug', { state: 'err', label: 'migrations failed' }, '1h 55m', 'main'],
        [8n, 'restart', 'rotate-cw', 'err', 'Restart · Console cycle 55: the System screen', 'rolled back to the last good bundle (crash-loop)', { state: 'err', label: 'rolled back' }, null, 'main'],
        [5n, 'restart', 'rotate-cw', undefined, 'Restart · Console cycle 55: the System screen', 'requested by engineer', { state: 'done', label: 'done' }, '38s', 'main'],
        [3n, 'restart', 'hourglass', undefined, 'Restart requested', 'engineer · Console cycle 55: the System screen', null, null, 't1'],
      ],
    );
    assert.equal(tookLabel(500), '1s');
    assert.equal(tookLabel(90_000), '1m');
  });

  it('marks a request after the newest completion as in the way, and an exception by its scope', () => {
    const log = [
      completed(5n, at(2026, 10, 11, 16, 5, 38), 3),
      requested(7n, at(2026, 10, 11, 17, 0), null),
      event({ seq: 8n, type: 'system.exception', actor: 'system', userId: null, payload: { scope: 'migrate-deploy', error: 'migration 0041_app_slug failed\nstack' } }),
      event({ seq: 9n, type: 'system.exception', actor: 'system', userId: null, payload: { scope: 'supervisor-rollback', error: 'Supervisor rolled back' } }),
      event({ seq: 10n, type: 'system.exception', actor: 'system', threadId: 'main', payload: { scope: 'workspace-job', slug: 'db-backup', runId: 'r', status: 'failed', exitCode: 127, error: 'pg_dump: not found' } }),
      event({ seq: 11n, type: 'system.exception', actor: 'system', targetThreadId: 'main', payload: { consumerName: 'router', eventType: 'user.message', error: "Cannot read properties of undefined (reading 'slug')" } }),
      event({ seq: 12n, type: 'system.exception', actor: 'system', payload: { scope: 'telegram-file-ingest', error: 'too big' } }),
      event({ seq: 13n, type: 'system.exception', actor: 'system', payload: { error: 'boom' } }),
    ];
    const rows = logRows(log);

    assert.deepEqual(
      rows.map(row => [row.seq, row.kind, row.icon, row.state, row.title, row.meta, row.status?.label ?? null, row.threadId]),
      [
        [13n, 'exception', 'triangle-alert', 'err', 'System exception', 'boom', null, null],
        [12n, 'exception', 'triangle-alert', 'err', 'Exception · telegram-file-ingest', 'too big', null, null],
        [11n, 'exception', 'triangle-alert', 'err', 'router failed on user.message', "Cannot read properties of undefined (reading 'slug')", null, 'main'],
        [10n, 'exception', 'calendar-x', 'err', 'Task “db-backup” failed', 'pg_dump: not found · exit code 127', null, 'main'],
        [9n, 'restart', 'rotate-ccw', 'err', 'Rolled back to the last good bundle', 'Supervisor rolled back', 'rolled back', null],
        [8n, 'restart', 'database', 'err', 'Migrations failed to apply', 'migration 0041_app_slug failed', 'failed', null],
        [7n, 'restart', 'hourglass', 'wait', 'Restart requested', 'the operator · Console cycle 55: the System screen', 'pending', 't1'],
        [5n, 'restart', 'rotate-cw', undefined, 'Restart · Console cycle 55: the System screen', '', 'done', 'main'],
      ],
    );
    assert.deepEqual(
      restartRows(rows).map(row => row.seq),
      [9n, 8n, 7n, 5n],
    );
    assert.deepEqual(
      filteredRows(rows, 'exception').map(row => row.seq),
      [13n, 12n, 11n, 10n],
    );
    assert.equal(filteredRows(rows, 'all').length, 8);
    assert.equal(emptyLogWords('all'), 'No system events yet');
    assert.equal(emptyLogWords('restart'), 'No restarts yet');
    assert.equal(emptyLogWords('exception'), 'No exceptions');
  });
});

describe('the summaries of Home', () => {
  it('says the CPU and the disk of what is known, the files and bytes of the area', () => {
    const machine = { uptimeSeconds: 1, cpu: { cores: 2, perCore: [10, 18], loadAvg: [0, 0, 0] as [number, number, number] }, memory: null, disk: { totalBytes: 200 * GB, usedBytes: 131 * GB, freeBytes: 69 * GB }, network: null };

    assert.equal(systemSummary({ machine }), 'CPU 14% · disk 66%');
    assert.equal(systemSummary({ machine: { ...machine, cpu: { ...machine.cpu, perCore: null } } }), 'disk 66%');
    assert.equal(systemSummary({ machine: { ...machine, cpu: { ...machine.cpu, perCore: null }, disk: null } }), null);
    assert.equal(systemSummary(null), null);
    assert.equal(fileAreaSummary({ files: 2418, bytes: 1.2 * GB }), '2,418 files · 1.2 GB');
    assert.equal(fileAreaSummary({ files: 1, bytes: 300, complete: true }), '1 file · 300 B');
    assert.equal(fileAreaSummary({ files: 1_000_000, bytes: 5 * GB, complete: false }), 'at least 1,000,000 files · 5 GB');
    assert.equal(fileAreaSummary(null), null);
  });
});
