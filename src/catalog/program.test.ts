// The runner of programs and the action `run_program`: what a program has in
// scope, where its calls go, how every way of ending comes back, and what a
// run that is over does to the calls it had started.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { z } from 'zod';
import { buildCatalog } from './catalog.ts';
import { capability } from './definition.ts';
import { CapabilityError } from './errors.ts';
import { computeGrant, type GrantPolicy } from './grant.ts';
import { countProgramCalls, countRunningPrograms, executeProgram, killRunningPrograms, programSyntaxProblem, runProgram, type ProgramRun } from './program.ts';
import { CALLER, WORK, testConnections, testRoot, type Calls } from './test-tree.ts';

const calls: Calls = [];
// What the slow capabilities of this test went through, in order.
const log: string[] = [];
let waitingNow = 0;
let waitingMost = 0;

const base = testRoot(calls);
const catalog = buildCatalog({
  ...base,
  children: [
    ...base.children,
    // A call that takes its time and goes on to its end whatever happens to
    // the program that made it.
    capability({
      name: 'wait',
      summary: 'Wait and say so',
      description: 'Wait the given time.',
      input: z.strictObject({ ms: z.int(), tag: z.string().default('wait') }),
      output: z.strictObject({ waited: z.int() }),
      async run({ ms, tag }) {
        waitingNow += 1;
        waitingMost = Math.max(waitingMost, waitingNow);
        await sleep(ms);
        waitingNow -= 1;
        log.push(`${tag}:done`);

        return { waited: ms };
      },
    }),
    // A call that belongs to the run, the way a command does: it ends when
    // the run is over.
    capability({
      name: 'hold',
      summary: 'Hold until the program is over',
      description: 'Hold until the run of the program is over.',
      input: z.strictObject({}),
      output: z.strictObject({ held: z.boolean() }),
      run(_input, { program, signal }) {
        return new Promise((_resolve, reject) => {
          const end = (why: string) => () => {
            log.push(`hold:${why}`);
            reject(new CapabilityError('external_error', `Held until ${why}.`));
          };

          program?.ended.addEventListener('abort', end('ended'), { once: true });
          signal?.addEventListener('abort', end('cancelled'), { once: true });
        });
      },
    }),
  ],
}).catalog;

const connections = testConnections({ accounts: { mail: [WORK] }, secrets: ['search'] });
const env = { connections };
const grantOf = (policy: Partial<GrantPolicy> = {}) =>
  computeGrant(
    catalog,
    { allows: () => true, actions: ['describe', 'call', 'run_program'], ...policy },
    { caller: CALLER, connections },
  );

const run = async (code: string, timeoutMs = 20_000) => executeProgram(await grantOf(), { code, timeoutMs }, env);

async function errorOf(promise: Promise<unknown>): Promise<CapabilityError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof CapabilityError);

    return error;
  }

  assert.fail('expected the program to fail');
}

describe('a program', () => {
  it('chains calls under the grant of its run and gives only what it returns', async () => {
    const grant = await grantOf();

    calls.length = 0;

    const value = await runProgram(
      grant,
      {
        code: `
          const note = await call('get_note', { id: 7 });
          const page = await call('notes_list');
          const sent = await call('mail_send', { to: 'a@b.test', text: note.title, account: 'work' });
          console.log('intermediate', page);
          return { id: note.id, notes: page.notes.length, sent: sent.messageId };
        `,
      },
      env,
    );

    assert.deepEqual(value, { id: 7, notes: 1, sent: 'from-work' });
    assert.deepEqual(
      calls.map(entry => [entry.name, entry.input]),
      [
        ['get_note', { id: 7 }],
        ['notes_list', { limit: 10 }],
        ['mail_send', { to: 'a@b.test', text: 'First' }],
      ],
    );

    // Every call is made for the caller of the grant and carries the one run.
    const runIds = new Set(calls.map(entry => entry.ctx.program?.runId));

    assert.equal(runIds.size, 1);
    assert.match([...runIds][0] ?? '', /^[0-9a-f-]{36}$/);
    assert.ok(calls.every(entry => entry.ctx.caller.threadId === CALLER.threadId && entry.ctx.signal === null));
  });

  it('describes a vertex by its name and the root without one', async () => {
    const outcome = await run(`
      const root = await describe();
      const node = await describe('notes');
      const leaf = await describe('notes_update');
      return { root: root.name, children: node.children.map(child => child.name), signature: leaf.signature };
    `);

    assert.equal(outcome.outcome, 'ok');

    const value = outcome.value as { root: string; children: string[]; signature: string };

    assert.equal(value.root, '');
    assert.deepEqual(value.children, ['notes_list', 'notes_update', 'notes_archive']);
    assert.match(value.signature, /notes_update\(input: \{/);
  });

  it('has the catalog and nothing of the host', async () => {
    const outcome = await run(`
      return {
        scope: [typeof call, typeof describe, typeof console.log],
        host: [typeof require, typeof process, typeof fetch, typeof setTimeout, typeof Buffer, typeof module],
        modules: await import('node:fs').then(() => 'loaded', error => error.code),
      };
    `);

    assert.deepEqual(outcome.value, {
      scope: ['function', 'function', 'function'],
      host: ['undefined', 'undefined', 'undefined', 'undefined', 'undefined', 'undefined'],
      modules: 'ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING',
    });
  });

  it('gets the error of a failed call as an exception with the same fields', async () => {
    const outcome = await run(`
      try {
        await call('get_note', { id: 404 });
      } catch (error) {
        return { isError: error instanceof Error, name: error.name, kind: error.kind, message: error.message, details: error.details };
      }
    `);

    assert.deepEqual(outcome.value, {
      isError: true,
      name: 'CapabilityError',
      kind: 'not_found',
      message: 'No note 404.',
      details: { id: 404 },
    });
  });

  it('calls only what its grant has', async () => {
    const grant = await grantOf({ allows: vertex => vertex.fullName !== 'notes' });
    const cut = await errorOf(runProgram(grant, { code: `return await call('notes_list')` }, env));

    assert.equal(cut.kind, 'unknown_capability');

    const action = await errorOf(runProgram(grant, { code: `return await call('run_program', { code: 'return 1' })` }, env));

    assert.equal(action.kind, 'unknown_capability');
  });

  it('runs under the id and the start its launcher gave: the calls and the outcome carry them', async () => {
    const start = { id: 'run-named-by-its-launcher', startedAt: new Date(Date.now() - 5_000) };

    calls.length = 0;

    const pending = executeProgram(
      await grantOf(),
      { code: `await call('get_note', { id: 7 }); await call('wait', { ms: 300 }); return 1;`, timeoutMs: 20_000, start },
      env,
    );

    // The program is still waiting for a call, and the call it made is
    // already under the id the launcher knew before the launch.
    await sleep(200);
    assert.equal(countRunningPrograms(), 1);
    assert.deepEqual(
      calls.map(entry => entry.ctx.program?.runId),
      [start.id],
    );

    const outcome = await pending;

    assert.equal(outcome.outcome, 'ok');
    assert.equal(outcome.id, start.id);
    assert.equal(outcome.startedAt, start.startedAt);
    assert.equal(outcome.durationMs, outcome.endedAt.getTime() - start.startedAt.getTime());
    assert.ok(outcome.durationMs >= 5_000);
  });

  it('gives the keeper of the record the whole run before the caller gets the value or the error', async () => {
    const grant = await grantOf();
    const kept: ProgramRun[] = [];
    const start = { id: 'run-of-a-recorded-call', startedAt: new Date() };
    const value = await runProgram(grant, { code: `console.log('for the record'); return { n: 1 };` }, { ...env, start, record: run => void kept.push(run) });

    assert.deepEqual(value, { n: 1 });
    assert.equal(kept.length, 1);
    assert.equal(kept[0]?.id, start.id);
    assert.equal(kept[0]?.startedAt, start.startedAt);
    assert.equal(kept[0]?.outcome, 'ok');
    assert.equal(kept[0]?.console, 'for the record\n');

    // A run that failed is recorded too, with what it had said, and the
    // record is there by the time the error leaves.
    const failed = await errorOf(
      runProgram(grant, { code: `console.log('said before'); throw new Error('broke');` }, { ...env, record: async run => void kept.push(run) }),
    );

    assert.equal(failed.kind, 'invalid_input');
    assert.equal(kept.length, 2);
    assert.equal(kept[1]?.outcome, 'failed');
    assert.equal(kept[1]?.error?.message, failed.message);
    assert.equal(kept[1]?.console, 'said before\n');
    assert.match(kept[1]?.id ?? '', /^[0-9a-f-]{36}$/);
  });

  it('returns any JSON value, and null when it has nothing to say', async () => {
    const grant = await grantOf();

    assert.equal(await runProgram(grant, { code: 'return null' }, env), null);
    assert.deepEqual(await runProgram(grant, { code: `return [1, 'two', { three: [true, null] }, 4.5]` }, env), [
      1,
      'two',
      { three: [true, null] },
      4.5,
    ]);
  });
});

describe('a program that fails', () => {
  it('passes on the error of a call it did not catch, the same kind and fields', async () => {
    const grant = await grantOf();
    const missing = await errorOf(runProgram(grant, { code: `await call('get_note', { id: 404 }); return 1` }, env));

    assert.deepEqual(missing.toValue(), { kind: 'not_found', message: 'No note 404.', details: { id: 404 } });

    const unknown = await errorOf(runProgram(grant, { code: `return await call('no_such_thing')` }, env));

    assert.equal(unknown.kind, 'unknown_capability');

    const misfit = await errorOf(runProgram(grant, { code: `return await call('get_note', { id: 'seven' })` }, env));

    assert.equal(misfit.kind, 'invalid_input');
    assert.match(misfit.message, /get_note\(input: \{/);

    const defect = await errorOf(runProgram(grant, { code: `return await call('get_note', { id: 500 })` }, env));

    assert.equal(defect.kind, 'internal');
  });

  it('answers invalid_input with the exception and its line when its own code throws', async () => {
    const outcome = await run(`const one = 1;\nconst two = 2;\nthrow new TypeError('a bad ' + (one + two));`);

    assert.equal(outcome.outcome, 'failed');
    assert.equal(outcome.value, null);
    assert.equal(outcome.error?.kind, 'invalid_input');
    assert.match(outcome.error?.message ?? '', /threw at line 3: TypeError: a bad 3/);
    assert.deepEqual(outcome.error?.details, { line: 3 });

    const nested = await run(`function deep() {\n  return null.field;\n}\nawait call('notes_list');\ndeep();`);

    assert.match(nested.error?.message ?? '', /threw at line 2: TypeError/);

    const plain = await run(`throw 'just a string'`);

    assert.match(plain.error?.message ?? '', /threw: just a string/);
    assert.deepEqual(plain.error?.details, { line: null });
  });

  it('answers invalid_input with the line when the code does not parse, and runs nothing', async () => {
    calls.length = 0;

    const outcome = await run(`await call('notes_list');\nconst broken = ;\nreturn 1;`);

    assert.equal(outcome.outcome, 'failed');
    assert.equal(outcome.error?.kind, 'invalid_input');
    assert.match(outcome.error?.message ?? '', /does not parse at line 2: SyntaxError/);
    assert.deepEqual(calls, []);

    const escape = await run(`}); (async function () { return 1;`);

    assert.equal(escape.error?.kind, 'invalid_input');
    assert.match(escape.error?.message ?? '', /does not parse/);
  });

  it('tells whether a text is code it would begin to run, without running it', () => {
    assert.equal(programSyntaxProblem(`const list = await call('notes_list');\nreturn list.length;`), null);
    assert.equal(programSyntaxProblem(''), null);
    assert.equal(programSyntaxProblem(`throw new Error('at run time')`), null);
    // The same answers the process of a run gives.
    assert.deepEqual(programSyntaxProblem(`await call('notes_list');\nconst broken = ;\nreturn 1;`), { text: "SyntaxError: Unexpected token ';'", line: 2 });
    assert.deepEqual(programSyntaxProblem(`}); (async function () { return 1;`), { text: 'SyntaxError: the code closes the function it is the body of', line: null });
    assert.match(programSyntaxProblem(`import fs from 'node:fs';`)?.text ?? '', /^SyntaxError/);
  });

  it('answers invalid_input when what it returned is not JSON', async () => {
    for (const [code, message] of [
      [`await call('notes_list');`, /what it returned is undefined/],
      [`return { when: new Date(0) }`, /`when` in what it returned is a Date object/],
      [`return { list: [1, { ratio: 0 / 0 }] }`, /`list\[1\]\.ratio` in what it returned is NaN/],
      [`const loop = {}; loop.self = loop; return loop`, /`self` in what it returned is an object that contains itself/],
      [`return { fn() {} }`, /`fn` in what it returned is a function/],
      [`return new Map()`, /what it returned is a Map object/],
    ] as const) {
      const outcome = await run(code);

      assert.equal(outcome.outcome, 'failed', code);
      assert.equal(outcome.error?.kind, 'invalid_input', code);
      assert.match(outcome.error?.message ?? '', message);
    }
  });

  it('fails on a call it started and left without a catch, and waits for a call it did not wait for', async () => {
    log.length = 0;

    const left = await run(`call('get_note', { id: 404 }); return 'fine';`);

    assert.equal(left.outcome, 'failed');
    assert.equal(left.error?.kind, 'not_found');

    const waited = await run(`call('wait', { ms: 200, tag: 'left' }); return 'fine';`);

    assert.equal(waited.outcome, 'ok');
    assert.equal(waited.value, 'fine');
    assert.deepEqual(log, ['left:done']);

    // A rejection that is caught later is not a failure.
    const late = await run(`
      const doomed = call('get_note', { id: 404 });
      await call('wait', { ms: 100 });
      return await doomed.catch(error => error.kind);
    `);

    assert.equal(late.value, 'not_found');
  });

  it('answers invalid_input when its process runs out of memory', async () => {
    const outcome = await executeProgram(
      await grantOf(),
      { code: `const hoard = []; for (;;) hoard.push(new Array(100000).fill(Math.random()));`, timeoutMs: 60_000, heapMb: 48 },
      env,
    );

    assert.equal(outcome.outcome, 'failed');
    assert.equal(outcome.error?.kind, 'invalid_input');
    assert.match(outcome.error?.message ?? '', /ran out of memory \(its process has 48 MB\)/);
  });
});

describe('the time of a program', () => {
  it('kills code that never yields, and the run says timeout', async () => {
    const outcome = await run(`console.log('before the loop'); for (;;) {}`, 400);

    assert.equal(outcome.outcome, 'timeout');
    assert.equal(outcome.error?.kind, 'invalid_input');
    assert.match(outcome.error?.message ?? '', /ran longer than 0\.4 seconds and was killed/);
    assert.deepEqual(outcome.error?.details, { unfinishedCalls: [] });
    assert.ok(outcome.durationMs < 5_000);
    // What it had said by then stays with the run.
    assert.equal(outcome.console, 'before the loop\n');
  });

  it('is the timeoutSeconds of run_program, within its range', async () => {
    const grant = await grantOf();
    const late = await errorOf(runProgram(grant, { code: `await call('wait', { ms: 1500, tag: 'slow' })`, timeoutSeconds: 1 }, env));

    assert.equal(late.kind, 'invalid_input');
    assert.match(late.message, /ran longer than 1 second and was killed/);

    for (const input of [{ code: 'return 1', timeoutSeconds: 601 }, { code: 'return 1', timeoutSeconds: 0 }, { timeoutSeconds: 5 }, null]) {
      const refused = await errorOf(runProgram(grant, input, env));

      assert.equal(refused.kind, 'invalid_input');
      assert.match(refused.message, /run_program\(input: \{/);
    }
  });

  it('takes the command of the program with it and lets any other started call reach its end', async () => {
    // The call the run before this one left behind is still counted, as it
    // should be: it has to end first.
    while (countProgramCalls() > 0) {
      await sleep(50);
    }

    log.length = 0;

    const outcome = await run(
      `await Promise.all([call('hold'), call('wait', { ms: 900, tag: 'outlives' })]); return 'never';`,
      300,
    );

    assert.equal(outcome.outcome, 'timeout');
    assert.deepEqual(outcome.error?.details, { unfinishedCalls: ['hold', 'wait'] });
    assert.match(outcome.error?.message ?? '', /Still running when it was killed: `hold`, `wait`/);
    // The call that belongs to the run ended with it; the other one has not
    // ended yet and is not cut short.
    const mine = () => log.filter(entry => entry.startsWith('hold:') || entry.startsWith('outlives:'));

    assert.deepEqual(mine(), ['hold:ended']);
    // The run is over, and the call that outlived it is still work in
    // flight: a restart waits for it.
    assert.equal(countRunningPrograms(), 0);
    assert.equal(countProgramCalls(), 1);

    await sleep(900);
    assert.deepEqual(mine(), ['hold:ended', 'outlives:done']);
    assert.equal(countProgramCalls(), 0);
  });

  it('starts no call that was still waiting its turn when the run was over', async () => {
    log.length = 0;
    waitingMost = 0;

    const outcome = await run(
      `await Promise.all(Array.from({ length: 20 }, (_, index) => call('wait', { ms: 600, tag: 'call-' + index })));`,
      300,
    );

    assert.equal(outcome.outcome, 'timeout');
    await sleep(900);
    assert.equal(log.filter(entry => entry.startsWith('call-')).length, 8);
    assert.equal(waitingMost, 8);
  });
});

describe('the calls of a program', () => {
  it('are carried out eight at a time, the rest in their turn', async () => {
    log.length = 0;
    waitingMost = 0;

    const outcome = await run(
      `const all = await Promise.all(Array.from({ length: 20 }, (_, index) => call('wait', { ms: 40, tag: 'call-' + index })));
       return all.length;`,
    );

    assert.equal(outcome.value, 20);
    assert.equal(log.length, 20);
    assert.equal(waitingMost, 8);
  });
});

describe('the console of a program', () => {
  it('stays with the run and is not what the caller gets', async () => {
    const outcome = await run(`
      console.log('plain', 7, { nested: [1, 2] }, null, undefined);
      console.error(new RangeError('too far'));
      console.warn('ёж 😀');
      return 'value';
    `);

    assert.equal(outcome.value, 'value');
    assert.equal(outcome.console, 'plain 7 {"nested":[1,2]} null undefined\nRangeError: too far\nёж 😀\n');
    assert.equal(outcome.consoleTruncated, false);
  });

  it('keeps the last 16 KiB of a long output, whole characters', async () => {
    // Lines of different lengths in bytes: the cut falls inside a character
    // for some of them.
    for (const filler of ['😀'.repeat(10), 'ёжик в тумане', 'я']) {
      const outcome = await run(`
        for (let index = 0; index < 3000; index += 1) console.log('line ' + index + ' ' + ${JSON.stringify(filler)});
        console.log('последняя строка');
        return null;
      `);
      const bytes = Buffer.byteLength(outcome.console, 'utf8');

      assert.equal(outcome.outcome, 'ok');
      assert.equal(outcome.consoleTruncated, true);
      // Bytes of UTF-8, not characters: Cyrillic text of 16 KiB is about
      // half as many characters.
      assert.ok(bytes <= 16 * 1024 && bytes > 16 * 1024 - 4, `${bytes} bytes`);
      assert.ok(outcome.console.endsWith('последняя строка\n'));
      // No half of a character at the cut.
      assert.ok(!outcome.console.includes('\ufffd'));
    }

    const short = await run(`console.log('ё'.repeat(8000)); return null;`);

    assert.equal(short.consoleTruncated, false);
    assert.equal(short.console.length, 8001);
  });
});

describe('a run that is stopped', () => {
  it('ends as aborted when its launcher cancels it, and its calls learn it', async () => {
    log.length = 0;

    const cancel = new AbortController();
    const pending = executeProgram(await grantOf(), { code: `await call('hold'); return 1;`, timeoutMs: 20_000 }, { connections, signal: cancel.signal });

    await sleep(300);
    assert.equal(countRunningPrograms(), 1);
    cancel.abort();

    const outcome = await pending;

    assert.equal(outcome.outcome, 'aborted');
    assert.equal(outcome.error?.kind, 'unavailable');
    assert.match(outcome.error?.message ?? '', /stopped before it ended: its run was cancelled/);
    assert.equal(log[0], 'hold:ended');
    assert.equal(countRunningPrograms(), 0);

    // A launch that is already cancelled runs nothing.
    calls.length = 0;

    const never = await executeProgram(await grantOf(), { code: `await call('notes_list'); return 1;`, timeoutMs: 20_000 }, { connections, signal: cancel.signal });

    assert.equal(never.outcome, 'aborted');
    assert.deepEqual(calls, []);
  });

  it('ends as aborted when the app stops its runs', async () => {
    log.length = 0;

    const first = run(`await call('hold'); return 1;`);
    const second = run(`for (;;) {}`);

    await sleep(300);
    assert.equal(countRunningPrograms(), 2);
    killRunningPrograms();
    // The scope of each run has ended by the time the call returns.
    assert.deepEqual(log, ['hold:ended']);

    for (const outcome of await Promise.all([first, second])) {
      assert.equal(outcome.outcome, 'aborted');
      assert.equal(outcome.error?.kind, 'unavailable');
      assert.match(outcome.error?.message ?? '', /Balabash is shutting down/);
    }

    assert.equal(countRunningPrograms(), 0);
  });
});
