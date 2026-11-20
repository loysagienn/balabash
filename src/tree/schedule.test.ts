// The node `schedule` over the stand: the registry of tasks through the one
// path of a call, and a program task run for real — the catalog's runner in
// a process of its own, on behalf of the stand's main thread. What the
// actions leave is read where the app keeps it: the registry events, the
// journal of scheduled runs, the events of the main thread. The journal is
// read as one history together with the runs of the former workspace jobs.
//
// Run: npm test  (node:test, native type stripping — no build needed).

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { CapabilityError, computeGrant, invokeCapability } from '../catalog/index.ts';
import type { ErrorKind, Grant } from '../catalog/index.ts';
import type { JsonObject } from '../core/contract.ts';
import { startStand } from '../test-support/stand.ts';
import type { Stand } from '../test-support/stand.ts';

let stand: Stand;
let prisma: typeof import('../db/client.ts')['prisma'];
let tree: typeof import('./index.ts');
let services: typeof import('./services.ts');
let grant: Grant;
let foreign: { workspaceId: string; grant: Grant };

type Value = Record<string, any>;

async function grantOf(workspaceId: string, threadId: string): Promise<Grant> {
  return computeGrant(
    tree.catalog(),
    { allows: () => true, actions: ['describe', 'call', 'run_program'] },
    { caller: { workspaceId, threadId, agentName: 'tester' }, connections: services.connectionsPort() },
  );
}

function invoke(name: string, input: JsonObject, as: Grant = grant): Promise<Value> {
  return invokeCapability(as, name, input, { connections: services.connectionsPort() }) as Promise<Value>;
}

async function refuses(call: Promise<unknown>, kind: ErrorKind, message: RegExp): Promise<void> {
  await assert.rejects(call, (error: unknown) => {
    assert.ok(error instanceof CapabilityError, `a CapabilityError, got ${String(error)}`);
    assert.equal(error.kind, kind);
    assert.match(error.message, message);

    return true;
  });
}

async function until<T>(read: () => Promise<T | null | undefined | false>, what: string, withinMs = 15_000): Promise<T> {
  for (const started = Date.now(); Date.now() - started < withinMs; ) {
    const value = await read();

    if (value) {
      return value;
    }

    await new Promise(resolve => setTimeout(resolve, 25));
  }

  return assert.fail(`timed out waiting for ${what}`);
}

// The run once it is over.
function ended(runId: string): Promise<Value> {
  return until(async () => {
    const run = await invoke('schedule_get_run', { runId });

    return run.status === 'running' ? null : run;
  }, `the end of the run ${runId}`);
}

// The events of a type the stand's workspace holds about a task.
async function eventsOf(type: string, slug: string) {
  const events = await prisma.event.findMany({ where: { workspaceId: stand.workspaceId, type }, orderBy: { seq: 'asc' } });

  return events.filter(event => (event.payload as JsonObject).slug === slug);
}

let counter = 0;

async function program(code: string, extra: JsonObject = {}): Promise<string> {
  const slug = `program-${(counter += 1)}`;

  await invoke('schedule_create_task', { slug, name: `Program ${counter}`, kind: 'program', code, ...extra });

  return slug;
}

before(async () => {
  stand = await startStand();
  ({ prisma } = await import('../db/client.ts'));
  tree = await import('./index.ts');
  services = await import('./services.ts');
  // What the app does at its start: among the rest, the schedule gets the
  // catalog its programs run against.
  await tree.startTree();
  grant = await grantOf(stand.workspaceId, stand.mainThreadId);

  const { workspaceFilesDir } = await import('../workspace/layout.ts');
  const { ensureMainThread } = await import('../core/threads.ts');
  const { id: workspaceId } = await prisma.workspace.create({ data: {} });
  const main = await ensureMainThread(workspaceId);

  await fs.mkdir(workspaceFilesDir(stand.workspaceId), { recursive: true });
  foreign = { workspaceId, grant: await grantOf(workspaceId, main.id) };
});

after(async () => {
  tree.stopRunningWork();
  await stand.stop();
});

describe('the registry of tasks', () => {
  test('registers a note with a trigger and gives the task as the list has it, authored by the calling thread', async () => {
    const task = await invoke('schedule_create_task', {
      slug: 'call-back',
      name: 'Call back',
      description: 'The electrician',
      kind: 'note',
      note: 'Call the electrician',
      at: '2031-05-01T09:00:00+03:00',
      wake: false,
    });

    assert.deepEqual(
      { ...task, createdAt: typeof task.createdAt },
      {
        slug: 'call-back',
        kind: 'note',
        name: 'Call back',
        description: 'The electrician',
        cron: null,
        at: '2031-05-01T06:00:00.000Z',
        nextRunAt: '2031-05-01T06:00:00.000Z',
        note: 'Call the electrician',
        code: null,
        timeoutSeconds: null,
        wake: false,
        running: false,
        createdBy: 'coordinator',
        createdAt: 'string',
      },
    );

    const [created] = await eventsOf('schedule.task.created', 'call-back');

    assert.equal(created?.threadId, stand.mainThreadId);
    assert.equal((created?.payload as JsonObject).wake, false);
  });

  test('registers a program with its code, its limit of time and a cron resolved to the next moment', async () => {
    const task = await invoke('schedule_create_task', {
      slug: 'digest',
      name: 'Digest',
      kind: 'program',
      code: "\n// a blank line above is kept\nreturn { n: 1 };",
      cron: '0 9 * * *',
      timeoutSeconds: 90,
    });

    assert.equal(task.kind, 'program');
    assert.equal(task.code, "\n// a blank line above is kept\nreturn { n: 1 };");
    assert.equal(task.note, null);
    assert.equal(task.timeoutSeconds, 90);
    assert.equal(task.wake, true);
    assert.equal(task.cron, '0 9 * * *');
    assert.ok(Date.parse(task.nextRunAt) > Date.now());

    const [created] = await eventsOf('schedule.task.created', 'digest');

    assert.equal((created?.payload as JsonObject).code, task.code);

    const plain = await invoke('schedule_create_task', { slug: 'by-hand', name: 'By hand', kind: 'program', code: 'return null;' });

    assert.equal(plain.timeoutSeconds, 600);
    assert.equal(plain.nextRunAt, null);
  });

  test('lists the tasks of the workspace oldest first with the timezone; a row of a former kind and a foreign task are not there', async () => {
    await prisma.scheduledTask.create({ data: { slug: 'old-job', workspaceId: stand.workspaceId, name: 'Old job', kind: 'command', command: 'true' } });
    await invoke('schedule_create_task', { slug: 'theirs', name: 'Theirs', kind: 'note', note: 'x' }, foreign.grant);

    const { timezone, tasks } = await invoke('schedule_list_tasks', {});

    assert.equal(timezone, 'Asia/Jerusalem');
    assert.deepEqual(
      tasks.map((task: Value) => task.slug),
      ['call-back', 'digest', 'by-hand'],
    );
    assert.deepEqual((await invoke('schedule_list_tasks', {}, foreign.grant)).tasks.map((task: Value) => task.slug), ['theirs']);
  });

  test('refuses what does not make a task, naming the field', async () => {
    const base = { slug: 'refused', name: 'Refused' };

    await refuses(invoke('schedule_create_task', { ...base, kind: 'note' }), 'invalid_input', /^note is required/);
    await refuses(invoke('schedule_create_task', { ...base, kind: 'note', note: 'x', code: 'return 1' }), 'invalid_input', /^code applies only to kind "program"/);
    await refuses(invoke('schedule_create_task', { ...base, kind: 'program' }), 'invalid_input', /^code is required/);
    await refuses(invoke('schedule_create_task', { ...base, kind: 'program', code: 'return 1', note: 'x' }), 'invalid_input', /^note applies only to kind "note"/);
    await refuses(
      invoke('schedule_create_task', { ...base, kind: 'program', code: 'const a = 1;\nreturn a +;' }),
      'invalid_input',
      /^code does not parse at line 2: SyntaxError/,
    );
    await refuses(
      invoke('schedule_create_task', { ...base, kind: 'program', code: 'return 1; }); (async function () {' }),
      'invalid_input',
      /^code does not parse: SyntaxError: the code closes the function/,
    );
    await refuses(invoke('schedule_create_task', { ...base, kind: 'note', note: 'x', cron: 'every day' }), 'invalid_input', /^cron expression "every day" is invalid/);
    await refuses(invoke('schedule_create_task', { ...base, kind: 'note', note: 'x', at: '2031-05-01T09:00:00' }), 'invalid_input', /^at must be an ISO 8601 instant with an explicit offset/);
    await refuses(
      invoke('schedule_create_task', { ...base, kind: 'note', note: 'x', cron: '0 9 * * *', at: '2031-05-01T09:00:00Z' }),
      'invalid_input',
      /cron.*at/,
    );
    await refuses(invoke('schedule_create_task', { ...base, kind: 'program', code: 'return 1', timeoutSeconds: 18_001 }), 'invalid_input', /timeoutSeconds/);
    assert.equal(await prisma.scheduledTask.count({ where: { slug: 'refused' } }), 0);
  });

  test('a taken slug is a conflict whoever holds it; a cancelled task frees it', async () => {
    await refuses(invoke('schedule_create_task', { slug: 'call-back', name: 'Again', kind: 'note', note: 'x' }), 'conflict', /slug "call-back" is already taken/);
    await refuses(invoke('schedule_create_task', { slug: 'theirs', name: 'Mine', kind: 'note', note: 'x' }), 'conflict', /already taken by a task of the installation/);

    assert.equal(await invoke('schedule_cancel_task', { slug: 'call-back' }), null);

    const [cancelled] = await eventsOf('schedule.task.cancelled', 'call-back');

    assert.equal((cancelled?.payload as JsonObject).reason, 'cancelled');
    assert.equal(cancelled?.threadId, stand.mainThreadId);
    await refuses(invoke('schedule_cancel_task', { slug: 'call-back' }), 'not_found', /no task with the slug "call-back"/);
    await refuses(invoke('schedule_cancel_task', { slug: 'theirs' }), 'not_found', /no task/);

    const again = await invoke('schedule_create_task', { slug: 'call-back', name: 'Call back', kind: 'note', note: 'Call the plumber' });

    assert.equal(again.note, 'Call the plumber');
  });
});

describe('a manual run', () => {
  test('of a note delivers the note to the main thread with the flag of the task, and is no journaled run', async () => {
    await invoke('schedule_create_task', { slug: 'quiet-note', name: 'Quiet', kind: 'note', note: 'Later', wake: false });

    assert.deepEqual(await invoke('schedule_run_task', { slug: 'call-back' }), { runId: null });
    assert.deepEqual(await invoke('schedule_run_task', { slug: 'quiet-note' }), { runId: null });

    const [loud] = await eventsOf('schedule.fired', 'call-back');
    const [quiet] = await eventsOf('schedule.fired', 'quiet-note');

    assert.deepEqual(loud?.payload, { note: 'Call the plumber', slug: 'call-back', name: 'Call back', wake: true });
    assert.equal(loud?.targetThreadId, stand.mainThreadId);
    assert.deepEqual(quiet?.payload, { note: 'Later', slug: 'quiet-note', name: 'Quiet', wake: false });
    // The schedule is untouched: the task is still there.
    assert.ok((await invoke('schedule_list_tasks', {})).tasks.some((task: Value) => task.slug === 'quiet-note'));
    assert.equal(await prisma.scheduleRun.count({ where: { slug: { in: ['call-back', 'quiet-note'] } } }), 0);
  });

  test('refuses a task the workspace does not have', async () => {
    await refuses(invoke('schedule_run_task', { slug: 'nothing' }), 'not_found', /no task with the slug "nothing"/);
    await refuses(invoke('schedule_run_task', { slug: 'theirs' }), 'not_found', /no task/);
  });

  test('of a program gives the id of its run at once; the value comes to the main thread and stays in the journal', async () => {
    const slug = await program(
      `
        console.log('counting', { tasks: true });
        const { tasks } = await call('schedule_list_tasks', {});
        const me = tasks.find(task => task.slug === ${JSON.stringify(`program-${counter + 1}`)});
        return { running: me.running, kinds: [...new Set(tasks.map(task => task.kind))].sort() };
      `,
      { wake: false },
    );
    const { hasUnsettledRuns } = await import('../schedule/programs.ts');
    const { runId } = await invoke('schedule_run_task', { slug });

    assert.match(runId, /^[0-9a-f-]{36}$/);
    // A restart waits for the run until its outcome is journaled and told.
    assert.equal(hasUnsettledRuns(), true);

    const run = await ended(runId);

    assert.equal(run.status, 'ok');
    assert.equal(run.slug, slug);
    assert.equal(run.trigger, 'manual');
    // The program saw itself in flight, through the catalog, as the main thread.
    assert.deepEqual(run.value, { running: true, kinds: ['note', 'program'] });
    assert.equal(run.error, null);
    assert.equal(run.console, 'counting {"tasks":true}\n');
    assert.equal(run.consoleTruncated, false);
    assert.match(run.code, /schedule_list_tasks/);
    assert.ok(run.durationMs >= 0);
    assert.ok(Date.parse(run.finishedAt) >= Date.parse(run.startedAt));

    const [fired] = await until(async () => {
      const events = await eventsOf('schedule.fired', slug);

      return events.length ? events : null;
    }, 'the value in the main thread');

    assert.deepEqual(fired?.payload, { runId, value: run.value, slug, name: 'Program 1', wake: false });
    assert.equal(fired?.targetThreadId, stand.mainThreadId);
    await until(async () => !hasUnsettledRuns(), 'the run to be settled');
    assert.equal((await invoke('schedule_list_tasks', {})).tasks.find((task: Value) => task.slug === slug).running, false);
  });

  test('of a program that returns null is silent and journaled all the same', async () => {
    const slug = await program('return null;');
    const run = await ended((await invoke('schedule_run_task', { slug })).runId);

    assert.equal(run.status, 'ok');
    assert.equal(run.value, null);

    const { runs } = await invoke('schedule_list_runs', { slug });

    assert.deepEqual(
      runs.map((item: Value) => [item.runId, item.status, item.hasValue]),
      [[run.runId, 'ok', false]],
    );
    assert.deepEqual((await invoke('schedule_list_runs', { slug, hasValue: true })).runs, []);
    // Nothing follows a settled silent run.
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.deepEqual(await eventsOf('schedule.fired', slug), []);
    assert.deepEqual(await eventsOf('system.exception', slug), []);
  });

  test('of a program that fails tells the main thread and keeps the error and the console', async () => {
    const slug = await program("console.log('before');\nawait call('workspace_run_command', { command: 'echo no >&2; exit 7' });");
    const run = await ended((await invoke('schedule_run_task', { slug })).runId);

    assert.equal(run.status, 'failed');
    assert.equal(run.value, null);
    // The error is whole: how the command failed is in its details.
    assert.match(run.error, /^external_error: The command exited with code 7\. .*\nDetails: \{/s);
    assert.deepEqual(JSON.parse(run.error.slice(run.error.indexOf('\nDetails: ') + 10)), {
      exitCode: 7,
      timedOut: false,
      stdout: '',
      stdoutTruncated: false,
      stderr: 'no\n',
      stderrTruncated: false,
    });
    assert.equal(run.console, 'before\n');

    const [exception] = await until(async () => {
      const events = await eventsOf('system.exception', slug);

      return events.length ? events : null;
    }, 'the failure in the main thread');
    const payload = exception?.payload as JsonObject;

    assert.equal(exception?.threadId, stand.mainThreadId);
    assert.equal(payload.scope, 'scheduled-program');
    assert.equal(payload.runId, run.runId);
    assert.equal(payload.status, 'failed');
    assert.match(String(payload.error), new RegExp(`^Scheduled task "${slug}" failed — external_error: .*schedule_get_run`, 's'));
    assert.deepEqual(await eventsOf('schedule.fired', slug), []);

    const thrown = await program("throw new TypeError('not this way');");
    const own = await ended((await invoke('schedule_run_task', { slug: thrown })).runId);

    assert.equal(own.status, 'failed');
    assert.match(own.error, /^invalid_input: The program threw at line 1: TypeError: not this way/);
  });

  test('of a program that outlives its limit of time ends as timeout, with its command gone', async () => {
    const slug = await program("await call('workspace_run_command', { command: 'sleep 60', timeoutSeconds: 120 });", { timeoutSeconds: 1 });
    const run = await ended((await invoke('schedule_run_task', { slug })).runId);

    assert.equal(run.status, 'timeout');
    assert.match(run.error, /^invalid_input: The program ran longer than 1 second/);

    const [exception] = await until(async () => {
      const events = await eventsOf('system.exception', slug);

      return events.length ? events : null;
    }, 'the timeout in the main thread');

    assert.equal((exception?.payload as JsonObject).status, 'timeout');
    assert.match(String((exception?.payload as JsonObject).error), /ran out of time/);
    await until(async () => !tree.hasRunningWork(), 'the command to be gone');
  });

  test('a scheduled program has the tree of the main thread without view_file, and no run_program', async () => {
    const slug = await program(`
      const root = await describe();
      let nested;
      try { await call('view_file', { file: 'f' }); } catch (error) { nested = error.kind; }
      return { names: root.children.map(child => child.name), nested, guide: root.guide.some(text => text.includes('run_program')) };
    `);
    const run = await ended((await invoke('schedule_run_task', { slug })).runId);

    assert.equal(run.status, 'ok');
    assert.ok(run.value.names.includes('schedule'));
    assert.ok(run.value.names.includes('export_file'));
    assert.ok(!run.value.names.includes('view_file'));
    assert.equal(run.value.nested, 'unknown_capability');
    assert.equal(run.value.guide, false);
  });

  test('while a run of the task is going, another is refused and the task says it is running', async () => {
    const slug = await program("await call('workspace_run_command', { command: 'sleep 60', timeoutSeconds: 120 });");
    const { runId } = await invoke('schedule_run_task', { slug });

    assert.equal((await invoke('schedule_get_run', { runId })).status, 'running');
    assert.equal((await invoke('schedule_list_tasks', {})).tasks.find((task: Value) => task.slug === slug).running, true);
    await refuses(invoke('schedule_run_task', { slug }), 'conflict', /A run of the task .* is already going/);
    assert.deepEqual(
      (await invoke('schedule_list_runs', { status: 'running' })).runs.map((item: Value) => item.runId),
      [runId],
    );

    // The app stops: the run ends as aborted and tells nobody.
    await until(async () => tree.hasRunningWork(), 'the run to be in flight');
    tree.stopRunningWork();

    const run = await ended(runId);

    assert.equal(run.status, 'aborted');
    assert.equal(run.error, null);
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.deepEqual(await eventsOf('system.exception', slug), []);
    assert.deepEqual(await eventsOf('schedule.fired', slug), []);
    // The task is free again.
    await until(async () => !(await invoke('schedule_list_tasks', {})).tasks.find((task: Value) => task.slug === slug).running, 'the task to be free');
  });

  test('the task stays taken until the value of its run is with the main thread', async () => {
    const slug = await program('return 1;');
    const { runId } = await invoke('schedule_run_task', { slug });

    // Whoever sees the task free — to run it again, to read its last value
    // from the journal — finds the run settled and its value told.
    await until(async () => !(await invoke('schedule_list_tasks', {})).tasks.find((task: Value) => task.slug === slug).running, 'the task to be free');
    assert.equal((await invoke('schedule_get_run', { runId })).status, 'ok');
    assert.equal((await eventsOf('schedule.fired', slug)).length, 1);
    assert.deepEqual(
      (await invoke('schedule_list_runs', { slug, hasValue: true })).runs.map((run: Value) => run.runId),
      [runId],
    );
  });
});

describe('what the main thread is told is what the journal holds', () => {
  test('a character the database does not hold is replaced in the journal as in the event', async () => {
    const slug = await program("console.log('a\\u0000b');\nreturn { text: 'c\\u0000d' };");
    const run = await ended((await invoke('schedule_run_task', { slug })).runId);

    assert.equal(run.status, 'ok');
    assert.equal(run.console, 'a\uFFFDb\n');
    assert.deepEqual(run.value, { text: 'c\uFFFDd' });

    const [fired] = await until(async () => {
      const events = await eventsOf('schedule.fired', slug);

      return events.length ? events : null;
    }, 'the value in the main thread');

    assert.deepEqual((fired?.payload as JsonObject).value, run.value);
    assert.deepEqual(await eventsOf('system.exception', slug), []);
  });

  test('a value the journal does not take is a failed run there and a failure in the main thread, never a value', async () => {
    // Half of a surrogate pair: jsonb refuses it.
    const slug = await program("console.log('said');\nreturn { text: 'cut \\ud83d' };");
    const run = await ended((await invoke('schedule_run_task', { slug })).runId);

    assert.equal(run.status, 'failed');
    assert.equal(run.value, null);
    assert.match(run.error, /^internal: The run ended as ok, but the journal did not take its outcome: /);

    const [exception] = await until(async () => {
      const events = await eventsOf('system.exception', slug);

      return events.length ? events : null;
    }, 'the failure in the main thread');
    const payload = exception?.payload as JsonObject;

    assert.equal(payload.runId, run.runId);
    assert.equal(payload.status, 'failed');
    assert.match(String(payload.error), new RegExp(`^Scheduled task "${slug}" failed — internal: The run ended as ok, but the journal did not take its outcome`));
    await until(async () => !(await invoke('schedule_list_tasks', {})).tasks.find((task: Value) => task.slug === slug).running, 'the task to be free');
    assert.deepEqual(await eventsOf('schedule.fired', slug), []);
  });
});

describe('the journal of runs', () => {
  test('a row left running by a dead process is settled as aborted at boot; a run of this process is not', async () => {
    const id = randomUUID();

    await prisma.scheduleRun.create({
      data: { id, workspaceId: stand.workspaceId, slug: 'orphan', trigger: 'cron', code: 'return 1;', status: 'running', startedAt: new Date('2026-01-01T00:00:00Z') },
    });

    const slug = await program("await call('workspace_run_command', { command: 'sleep 2' });\nreturn 'lived';");
    const live = await invoke('schedule_run_task', { slug });
    const { sweepAbortedRuns } = await import('../schedule/programs.ts');

    await sweepAbortedRuns();

    const run = await invoke('schedule_get_run', { runId: id });

    assert.equal(run.status, 'aborted');
    assert.ok(run.finishedAt);
    assert.equal(run.durationMs, null);
    // The run in flight was left alone: a reader never sees it end twice.
    assert.equal((await invoke('schedule_get_run', { runId: live.runId })).status, 'running');
    assert.equal((await ended(live.runId)).value, 'lived');
  });

  test('is one history with the runs of the former workspace jobs, paged newest first', async () => {
    const T0 = Date.parse('2026-03-01T10:00:00.000Z');
    const at = (minutes: number) => new Date(T0 + minutes * 60_000);
    const ids = { p1: '10000000-0000-4000-8000-000000000001', j1: '10000000-0000-4000-8000-000000000002', j2: '10000000-0000-4000-8000-000000000003', p2: '10000000-0000-4000-8000-000000000004', j3: '10000000-0000-4000-8000-000000000005', j4: '10000000-0000-4000-8000-000000000006' };
    const slug = 'mixed';
    const programRun = (id: string, startedAt: Date, data: Record<string, unknown> = {}) =>
      prisma.scheduleRun.create({
        data: { id, workspaceId: stand.workspaceId, slug, trigger: 'cron', code: 'return 1;', status: 'ok', startedAt, finishedAt: new Date(startedAt.getTime() + 500), durationMs: 500, ...data },
      });
    const jobRun = (id: string, startedAt: Date, data: Record<string, unknown> = {}) =>
      prisma.jobRun.create({
        data: { id, workspaceId: stand.workspaceId, slug, command: 'df -h', trigger: 'cron', status: 'ok', exitCode: 0, startedAt, finishedAt: new Date(startedAt.getTime() + 1_500), durationMs: 1_500, stdoutTail: 'disk ok', ...data },
      });

    await jobRun(ids.j1, at(1), { cwd: 'ops' });
    await programRun(ids.p1, at(2), { value: { n: 1 }, hasValue: true });
    // Two runs started in the same millisecond, one of each half.
    await jobRun(ids.j2, at(3), { status: 'failed', exitCode: 3, stderrTail: 'boom\n', stdoutTruncated: true });
    await programRun(ids.p2, at(3), { status: 'failed', error: { kind: 'invalid_input', message: 'The program threw at line 1: Error: x' } });
    await jobRun(ids.j3, at(4), { status: 'spawn_error', exitCode: null, stdoutTail: '', stderrTail: 'spawn bash ENOENT' });
    await jobRun(ids.j4, at(5), { status: 'timeout', exitCode: null });
    await prisma.jobRun.create({ data: { id: randomUUID(), workspaceId: foreign.workspaceId, slug, command: 'true', trigger: 'cron', status: 'ok', startedAt: at(6) } });

    const first = await invoke('schedule_list_runs', { slug, limit: 2 });

    assert.deepEqual(
      first.runs.map((run: Value) => [run.runId, run.status, run.hasValue]),
      [
        [ids.j4, 'timeout', false],
        [ids.j3, 'failed', false],
      ],
    );
    assert.equal(typeof first.nextCursor, 'string');

    const second = await invoke('schedule_list_runs', { slug, limit: 2, cursor: first.nextCursor });

    assert.deepEqual(
      second.runs.map((run: Value) => run.runId),
      [ids.p2, ids.j2],
    );

    const third = await invoke('schedule_list_runs', { slug, limit: 2, cursor: second.nextCursor });

    assert.deepEqual(
      third.runs.map((run: Value) => run.runId),
      [ids.p1, ids.j1],
    );
    assert.equal(third.nextCursor, null);

    assert.deepEqual(
      (await invoke('schedule_list_runs', { slug, status: 'failed' })).runs.map((run: Value) => run.runId),
      [ids.j3, ids.p2, ids.j2],
    );
    assert.deepEqual(
      (await invoke('schedule_list_runs', { slug, hasValue: true })).runs.map((run: Value) => run.runId),
      [ids.p1],
    );
    assert.deepEqual((await invoke('schedule_list_runs', { slug }, foreign.grant)).runs.length, 1);
    await refuses(invoke('schedule_list_runs', { slug, cursor: 'yesterday' }), 'invalid_input', /cursor is not a cursor of this list/);

    // A job's run reads as the run of the program its task turns into.
    const job = await invoke('schedule_get_run', { runId: ids.j1 });

    assert.deepEqual(job, {
      runId: ids.j1,
      slug,
      trigger: 'cron',
      status: 'ok',
      startedAt: at(1).toISOString(),
      finishedAt: new Date(at(1).getTime() + 1_500).toISOString(),
      durationMs: 1_500,
      code: `await call('workspace_run_command', {"command":"df -h","cwd":"ops"});\nreturn null;`,
      value: null,
      error: null,
      console: 'disk ok',
      consoleTruncated: false,
    });

    const failed = await invoke('schedule_get_run', { runId: ids.j2 });

    assert.equal(failed.error, 'external_error: The command exited with code 3.');
    assert.equal(failed.console, 'disk ok\nboom\n');
    assert.equal(failed.consoleTruncated, true);
    assert.match((await invoke('schedule_get_run', { runId: ids.j3 })).error, /could not be started: spawn bash ENOENT/);

    // The two ends of a job's output together keep to the limit of a console.
    const long = '10000000-0000-4000-8000-000000000007';

    await jobRun(long, at(0), { stdoutTail: `${'o'.repeat(11_999)}\n`, stderrTail: 'e'.repeat(12_000) });

    const capped = await invoke('schedule_get_run', { runId: long });

    assert.equal(Buffer.byteLength(capped.console), 16 * 1024);
    assert.ok(capped.console.endsWith('e'.repeat(12_000)));
    assert.equal(capped.consoleTruncated, true);
    assert.match((await invoke('schedule_get_run', { runId: ids.j4 })).error, /ran longer than its limit/);

    const withValue = await invoke('schedule_get_run', { runId: ids.p1 });

    assert.deepEqual(withValue.value, { n: 1 });
    assert.equal((await invoke('schedule_get_run', { runId: ids.p2 })).error, 'invalid_input: The program threw at line 1: Error: x');
    await refuses(invoke('schedule_get_run', { runId: ids.p1 }, foreign.grant), 'not_found', /no journaled run/);
    await refuses(invoke('schedule_get_run', { runId: 'nothing' }), 'not_found', /no journaled run with the id "nothing"/);
  });
});
