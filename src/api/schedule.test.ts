// The schedule over the stand (src/test-support/stand.ts): the run journal
// is read newest first by pages on a keyset cursor, one run comes whole with
// its tails, the newest run of every task is one row each; a manual run
// fires a note into the main thread's log and a command job into the
// journal (a real bash on the stand), a sleeping code task is refused; a
// delete answers the row and journals schedule.task.cancelled by the
// operator; another workspace's tasks and runs are not found, not forbidden.
//
// Run: npm test  (node:test, native type stripping — no build needed).

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { startStand } from '../test-support/stand.ts';
import type { Stand } from '../test-support/stand.ts';
import type { DeleteTaskResponse, JobRunResponse, JobRunsResponse, LatestJobRunsResponse, RunTaskResponse } from './contract.ts';

type ErrorBody = { error: { code: string; message: string } };

let stand: Stand;
let prisma: typeof import('../db/client.ts')['prisma'];

const FOREIGN_USER = randomUUID();
const T0 = new Date('2026-10-10T10:00:00.000Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

// Ids sort the way the keyset needs them to be told apart (the same
// startedAt twice below).
const RUNS = {
  oldest: 'a0000000-0000-4000-8000-000000000001',
  twinA: 'a0000000-0000-4000-8000-000000000002',
  twinB: 'a0000000-0000-4000-8000-000000000003',
  newest: 'a0000000-0000-4000-8000-000000000004',
  other: 'a0000000-0000-4000-8000-000000000005',
  foreign: 'a0000000-0000-4000-8000-000000000006',
};

before(async () => {
  stand = await startStand();
  ({ prisma } = await import('../db/client.ts'));

  const { workspaceFilesDir } = await import('../workspace/layout.ts');

  await fs.mkdir(workspaceFilesDir(stand.userId), { recursive: true });

  const task = (slug: string, data: Record<string, unknown>) => prisma.scheduledTask.create({ data: { slug, userId: stand.userId, name: slug, kind: 'command', ...data } });

  await task('remind', { kind: 'note', note: 'Call the electrician', at: at(60), createdBy: 'coordinator' });
  await task('echo-job', { command: "printf 'hello\\n'; printf 'warn\\n' >&2", timeoutMs: 5_000, createdBy: 'engineer' });
  await task('disk-check', { command: 'df -h', cron: '0 */6 * * *' });
  await task('sleeper', { kind: 'code', cron: '0 9 * * *' });
  await prisma.scheduledTask.create({ data: { slug: 'foreign-job', userId: FOREIGN_USER, name: 'Foreign', kind: 'command', command: 'true' } });

  const run = (id: string, slug: string, startedAt: Date, data: Record<string, unknown> = {}) =>
    prisma.jobRun.create({ data: { id, userId: stand.userId, slug, command: 'df -h', trigger: 'cron', status: 'ok', exitCode: 0, startedAt, finishedAt: new Date(startedAt.getTime() + 1_500), durationMs: 1_500, ...data } });

  await run(RUNS.oldest, 'disk-check', at(0), { status: 'failed', exitCode: 1, stderrTail: 'df: /mnt: No such file or directory\n', stdoutTail: 'Filesystem Size Used\n' });
  await run(RUNS.twinA, 'disk-check', at(10));
  await run(RUNS.twinB, 'disk-check', at(10), { trigger: 'manual' });
  await run(RUNS.newest, 'disk-check', at(20), { status: 'timeout', exitCode: null, durationMs: 5_000, stdoutTail: 'x'.repeat(40), stdoutTruncated: true });
  await run(RUNS.other, 'echo-job', at(15), { command: 'echo', durationMs: 20 });
  await prisma.jobRun.create({ data: { id: RUNS.foreign, userId: FOREIGN_USER, slug: 'foreign-job', command: 'true', trigger: 'cron', status: 'ok', exitCode: 0, startedAt: at(30) } });
});

after(() => stand.stop());

async function scheduleEvents(): Promise<{ type: string; actor: string; threadId: string | null; targetThreadId: string | null; payload: Record<string, unknown> }[]> {
  const rows = await prisma.event.findMany({ where: { type: { startsWith: 'schedule.' } }, orderBy: { seq: 'asc' } });

  return rows.map(row => ({ type: row.type, actor: row.actor, threadId: row.threadId, targetThreadId: row.targetThreadId, payload: row.payload as Record<string, unknown> }));
}

// Waits for the detached job to settle its journal row.
async function settledRun(id: string): Promise<JobRunResponse['run']> {
  for (let i = 0; i < 200; i += 1) {
    const reply = await stand.request('GET', `/api/schedule/runs/${id}`);

    assert.equal(reply.status, 200, reply.text);

    const { run } = reply.json<JobRunResponse>();

    if (run.status !== 'running') {
      return run;
    }

    await new Promise(resolve => setTimeout(resolve, 50));
  }

  throw new Error(`run ${id} did not settle`);
}

describe('the run journal over the api', () => {
  test('GET /schedule/runs lists the runs of the workspace newest first, without the tails', async () => {
    const reply = await stand.request('GET', '/api/schedule/runs');

    assert.equal(reply.status, 200, reply.text);

    const { runs, nextCursor } = reply.json<JobRunsResponse>();

    assert.deepEqual(
      runs.map(run => run.id),
      [RUNS.newest, RUNS.other, RUNS.twinB, RUNS.twinA, RUNS.oldest],
    );
    assert.equal(nextCursor, null);
    assert.deepEqual(runs[0], {
      id: RUNS.newest,
      slug: 'disk-check',
      trigger: 'cron',
      status: 'timeout',
      exitCode: null,
      startedAt: at(20),
      finishedAt: new Date(at(20).getTime() + 1_500),
      durationMs: 5_000,
      stdoutTruncated: true,
      stderrTruncated: false,
    });
  });

  test('pages follow a keyset cursor: two runs of one millisecond are not lost between pages; a cursor of no run is the end', async () => {
    const first = await stand.request('GET', '/api/schedule/runs?limit=2');

    assert.equal(first.status, 200, first.text);

    const page1 = first.json<JobRunsResponse>();

    assert.deepEqual(page1.runs.map(run => run.id), [RUNS.newest, RUNS.other]);
    assert.equal(page1.nextCursor, RUNS.other);

    const second = await stand.request('GET', `/api/schedule/runs?limit=2&before=${page1.nextCursor}`);
    const page2 = second.json<JobRunsResponse>();

    assert.deepEqual(page2.runs.map(run => run.id), [RUNS.twinB, RUNS.twinA]);
    assert.equal(page2.nextCursor, RUNS.twinA);

    const third = await stand.request('GET', `/api/schedule/runs?limit=2&before=${page2.nextCursor}`);
    const page3 = third.json<JobRunsResponse>();

    assert.deepEqual(page3.runs.map(run => run.id), [RUNS.oldest]);
    assert.equal(page3.nextCursor, null);

    const nowhere = await stand.request('GET', `/api/schedule/runs?before=${RUNS.foreign}`);

    assert.deepEqual(nowhere.json<JobRunsResponse>(), { runs: [], nextCursor: null });

    const bad = await stand.request('GET', '/api/schedule/runs?limit=0');

    assert.equal(bad.status, 400);
    assert.equal(bad.json<ErrorBody>().error.code, 'bad_request');
  });

  test('slug narrows the page to one task', async () => {
    const reply = await stand.request('GET', '/api/schedule/runs?slug=echo-job');

    assert.deepEqual(reply.json<JobRunsResponse>().runs.map(run => run.id), [RUNS.other]);

    const none = await stand.request('GET', '/api/schedule/runs?slug=foreign-job');

    assert.deepEqual(none.json<JobRunsResponse>().runs, []);
  });

  test('GET /schedule/runs/latest answers the newest run of every task, newest first', async () => {
    const reply = await stand.request('GET', '/api/schedule/runs/latest');

    assert.equal(reply.status, 200, reply.text);
    assert.deepEqual(
      reply.json<LatestJobRunsResponse>().runs.map(run => [run.slug, run.id]),
      [
        ['disk-check', RUNS.newest],
        ['echo-job', RUNS.other],
      ],
    );
  });

  test('GET /schedule/runs/:id is the run whole; a run of another workspace is not found', async () => {
    const reply = await stand.request('GET', `/api/schedule/runs/${RUNS.oldest}`);

    assert.equal(reply.status, 200, reply.text);

    const { run } = reply.json<JobRunResponse>();

    assert.equal(run.command, 'df -h');
    assert.equal(run.cwd, null);
    assert.equal(run.stdoutTail, 'Filesystem Size Used\n');
    assert.equal(run.stderrTail, 'df: /mnt: No such file or directory\n');
    assert.equal(run.status, 'failed');
    assert.equal(run.exitCode, 1);

    const foreign = await stand.request('GET', `/api/schedule/runs/${RUNS.foreign}`);

    assert.equal(foreign.status, 404);
    assert.equal(foreign.json<ErrorBody>().error.code, 'not_found');
  });

  test('without a session: 401', async () => {
    const reply = await stand.request('GET', '/api/schedule/runs', { cookie: '' });

    assert.equal(reply.status, 401);
  });
});

describe('running and deleting a task over the api', () => {
  test('a note task fired by hand lands in the main thread as schedule.fired; the row stays', async () => {
    const reply = await stand.request('POST', '/api/schedule/tasks/remind/run');

    assert.equal(reply.status, 200, reply.text);
    assert.deepEqual(reply.json<RunTaskResponse>(), { outcome: 'fired', runId: null });

    const events = await scheduleEvents();

    assert.equal(events.length, 1);
    assert.equal(events[0]!.type, 'schedule.fired');
    assert.equal(events[0]!.actor, 'system');
    assert.equal(events[0]!.targetThreadId, stand.mainThreadId);
    assert.deepEqual(events[0]!.payload, { slug: 'remind', name: 'remind', note: 'Call the electrician' });

    assert.ok(await prisma.scheduledTask.findUnique({ where: { slug: 'remind' } }), 'a manual run does not consume the one-shot');
  });

  test('a command task fired by hand runs in the file area and settles its journal row with both tails', async () => {
    const reply = await stand.request('POST', '/api/schedule/tasks/echo-job/run');

    assert.equal(reply.status, 200, reply.text);

    const { outcome, runId } = reply.json<RunTaskResponse>();

    assert.equal(outcome, 'fired');
    assert.ok(runId);

    const run = await settledRun(runId);

    assert.equal(run.status, 'ok', JSON.stringify(run));
    assert.equal(run.exitCode, 0);
    assert.equal(run.trigger, 'manual');
    assert.equal(run.slug, 'echo-job');
    assert.equal(run.stdoutTail, 'hello\n');
    assert.equal(run.stderrTail, 'warn\n');
    assert.equal(run.command, "printf 'hello\\n'; printf 'warn\\n' >&2");
    assert.ok(run.finishedAt instanceof Date && run.durationMs !== null);

    const latest = await stand.request('GET', '/api/schedule/runs/latest');

    assert.equal(latest.json<LatestJobRunsResponse>().runs[0]?.id, runId, 'the manual run is the newest of its task');

    // A silent success writes no event: the journal alone knows it.
    assert.equal((await scheduleEvents()).length, 1);
  });

  test('a sleeping code task, an unknown slug and a task of another workspace are refused', async () => {
    const sleeping = await stand.request('POST', '/api/schedule/tasks/sleeper/run');

    assert.equal(sleeping.status, 409);
    assert.equal(sleeping.json<ErrorBody>().error.code, 'task_sleeping');
    assert.match(sleeping.json<ErrorBody>().error.message, /is sleeping/);

    const unknown = await stand.request('POST', '/api/schedule/tasks/no-such-task/run');

    assert.equal(unknown.status, 404);
    assert.equal(unknown.json<ErrorBody>().error.code, 'not_found');

    const foreign = await stand.request('POST', '/api/schedule/tasks/foreign-job/run');

    assert.equal(foreign.status, 404);
  });

  test('a cross-site run is refused before anything fires', async () => {
    const reply = await stand.request('POST', '/api/schedule/tasks/remind/run', { headers: { origin: 'https://evil.example' } });

    assert.equal(reply.status, 403);
    assert.equal(reply.json<ErrorBody>().error.code, 'cross_site');
    assert.equal((await scheduleEvents()).length, 1);
  });

  test('DELETE /schedule/tasks/:slug answers the row and journals schedule.task.cancelled by the operator; again — not found', async () => {
    const reply = await stand.request('DELETE', '/api/schedule/tasks/disk-check');

    assert.equal(reply.status, 200, reply.text);

    const { task } = reply.json<DeleteTaskResponse>();

    assert.equal(task.slug, 'disk-check');
    assert.equal(task.kind, 'command');
    assert.equal(task.cron, '0 */6 * * *');
    assert.ok(task.nextRunAt instanceof Date);
    assert.equal(await prisma.scheduledTask.findUnique({ where: { slug: 'disk-check' } }), null);

    const events = await scheduleEvents();
    const cancelled = events[events.length - 1]!;

    assert.equal(cancelled.type, 'schedule.task.cancelled');
    assert.equal(cancelled.actor, 'user');
    assert.equal(cancelled.threadId, null);
    assert.equal(cancelled.payload.slug, 'disk-check');
    assert.equal(cancelled.payload.reason, 'cancelled');
    assert.equal(cancelled.payload.id, task.id);

    // The journal of the deleted task stays readable.
    const runs = await stand.request('GET', '/api/schedule/runs?slug=disk-check');

    assert.equal(runs.json<JobRunsResponse>().runs.length, 4);

    const again = await stand.request('DELETE', '/api/schedule/tasks/disk-check');

    assert.equal(again.status, 404);
    assert.equal(again.json<ErrorBody>().error.code, 'not_found');
    assert.equal((await scheduleEvents()).length, events.length);
  });

  test('a task of another workspace cannot be deleted and is not told apart from a missing one', async () => {
    const reply = await stand.request('DELETE', '/api/schedule/tasks/foreign-job');

    assert.equal(reply.status, 404);
    assert.ok(await prisma.scheduledTask.findUnique({ where: { slug: 'foreign-job' } }));
  });
});
