// The app-server client over a fake server (a node script speaking the
// protocol on stdio): the handshake in order (initialize, `initialized`,
// the read), the checked answer, the server's error, a server that exits
// before answering (its stderr in the message), a command that cannot
// start, a round ended by its signal — and the server's child process gone
// after it; a server that drops its input mid-round (EPIPE on the client's
// stdin — the round's failure, never the app process's end), a server that
// keeps talking after the answer. The checks of the answer's fields.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { CodexRateLimitsResponse } from './app-server.ts';
import { rateLimitsOfResult, readCodexRateLimits } from './app-server.ts';

const FAKE = `
const fs = require('node:fs');
const rl = require('node:readline').createInterface({ input: process.stdin });
const mode = process.env.FAKE_MODE;
let initialized = false;
if (process.env.FAKE_PID_FILE) fs.writeFileSync(process.env.FAKE_PID_FILE, String(process.pid));
const out = m => process.stdout.write(JSON.stringify(m) + '\\n');
rl.on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') {
    if (mode === 'drop-stdin') {
      // The server lets go of its input before answering: the read end of
      // the client's stdin pipe is gone, the client's next write gets EPIPE.
      rl.close(); process.stdin.pause(); fs.closeSync(0);
      out({ id: m.id, result: { userAgent: 'fake' } });
      setTimeout(() => process.exit(0), 400);
      return;
    }
    process.stdout.write('not json\\n');
    out({ method: 'configWarning', params: { summary: 'noise' } });
    out({ id: m.id, result: { userAgent: 'fake' } });
  } else if (m.method === 'initialized') {
    initialized = true;
  } else if (m.method === 'account/rateLimits/read') {
    if (!initialized) return out({ id: m.id, error: { code: -32002, message: 'not initialized' } });
    if (mode === 'error') out({ id: m.id, error: { code: -32000, message: 'unauthorized' } });
    else if (mode === 'exit') { process.stderr.write('ERROR codex_app_server: no auth\\n'); process.exit(3); }
    else if (mode === 'hang') {}
    else if (mode === 'malformed') out({ id: m.id, result: { rateLimits: { primary: { usedPercent: 'many' } } } });
    else if (mode === 'chatty') {
      // The answer, then the handshake's answer again and the answer again:
      // a client that still listened would write to its ended stdin.
      out({ id: m.id, result: JSON.parse(process.env.FAKE_RESULT) });
      out({ id: 1, result: { userAgent: 'fake' } });
      out({ id: m.id, result: { rateLimits: {} } });
      setTimeout(() => process.exit(0), 300);
    }
    else out({ id: m.id, result: JSON.parse(process.env.FAKE_RESULT) });
  }
});
rl.on('close', () => { if (mode !== 'drop-stdin' && mode !== 'chatty') process.exit(0); });
`;

const WINDOW = { usedPercent: 63, windowDurationMins: 10080, resetsAt: 1792115459 };
const RESULT = {
  rateLimits: { limitId: 'codex', primary: WINDOW, secondary: null, planType: 'prolite' },
  rateLimitsByLimitId: { codex: { limitId: 'codex', primary: WINDOW, secondary: null, planType: 'prolite' } },
  rateLimitResetCredits: { availableCount: 3 },
};
const SNAPSHOT = { limitId: 'codex', limitName: null, primary: WINDOW, secondary: null, planType: 'prolite', rateLimitReachedType: null, spendControlReached: null, credits: null, individualLimit: null };
// RESULT as the client answers it: every field of the protocol present, the
// unsaid ones null.
const CHECKED: CodexRateLimitsResponse = { rateLimits: SNAPSHOT, rateLimitsByLimitId: { codex: SNAPSHOT }, rateLimitResetCredits: { availableCount: 3 } };

function fake(mode: string, pidFile?: string) {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), FAKE_MODE: mode, FAKE_RESULT: JSON.stringify(RESULT) };

  if (pidFile) {
    env.FAKE_PID_FILE = pidFile;
  }

  return { command: process.execPath, args: ['-e', FAKE], env };
}

function pidFileIn(dir: string): string {
  return path.join(dir, 'fake.pid');
}

// The pid the fake writes at its start — awaited: under the load of the
// whole suite a node process takes its time to come up.
async function pidOf(file: string): Promise<number> {
  const deadline = Date.now() + 10_000;

  for (;;) {
    const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';

    if (/^\d+$/.test(text)) {
      return Number(text);
    }

    if (Date.now() > deadline) {
      assert.fail(`the fake server did not write its pid to ${file}`);
    }

    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

async function assertGone(pid: number, within: number): Promise<void> {
  const deadline = Date.now() + within;

  for (;;) {
    try {
      // Signal 0: alive or not, nothing sent. A zombie still counts as
      // alive until its parent reaps it; the client's child is reaped by
      // this process on 'exit'.
      process.kill(pid, 0);
    } catch {
      return;
    }

    if (Date.now() > deadline) {
      assert.fail(`the server's process ${pid} is still alive after ${within} ms`);
    }

    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

describe('readCodexRateLimits', () => {
  it('initializes, announces, asks and answers the checked body; the server’s noise is ignored', async () => {
    assert.deepEqual(await readCodexRateLimits({ command: fake('ok') }), CHECKED);
  });

  it('the server’s error for the request is the failure', async () => {
    await assert.rejects(readCodexRateLimits({ command: fake('error') }), { message: 'account/rateLimits/read: unauthorized (code -32000)' });
  });

  it('a server that exits before answering fails with its exit and the last line of its stderr', async () => {
    await assert.rejects(readCodexRateLimits({ command: fake('exit') }), { message: 'codex app-server exited before answering (code 3): ERROR codex_app_server: no auth' });
  });

  it('a malformed answer is a failure, not a view', async () => {
    await assert.rejects(readCodexRateLimits({ command: fake('malformed') }), { message: 'account/rateLimits/read answered with a malformed rateLimits.primary.usedPercent' });
  });

  it('a command that cannot start fails at once', async () => {
    await assert.rejects(readCodexRateLimits({ command: { command: '/nonexistent/codex', args: ['app-server'], env: {} } }), /codex app-server could not start: spawn \/nonexistent\/codex ENOENT/);
  });

  it('the signal ends a round the server does not answer, with its reason; the server’s process is killed', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-server-test-'));

    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    const controller = new AbortController();
    const pending = readCodexRateLimits({ command: fake('hang', pidFileIn(dir)), signal: controller.signal });
    // The server is up and silent: end the round.
    const pid = await pidOf(pidFileIn(dir));

    controller.abort(new Error('no answer within 0.1 s'));
    await assert.rejects(pending, { message: 'no answer within 0.1 s' });
    await assertGone(pid, 3_000);

    const already = new AbortController();

    already.abort(new Error('gone'));
    await assert.rejects(readCodexRateLimits({ command: fake('ok'), signal: already.signal }), { message: 'gone' });
  });

  it('a server that drops its input mid-round is the round’s failure (EPIPE on stdin), and its process ends', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-server-test-'));

    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

    await assert.rejects(readCodexRateLimits({ command: fake('drop-stdin', pidFileIn(dir)) }), { message: 'codex app-server stdin: write EPIPE' });
    await assertGone(await pidOf(pidFileIn(dir)), 3_000);
  });

  it('the app process survives a server that drops its input: the failure is the promise’s, not an unhandled error event', async () => {
    // A fresh node process with no handlers of its own, so that an
    // unhandled 'error' event on a pipe would end it with code 1.
    const module = fileURLToPath(new URL('./app-server.ts', import.meta.url));
    const script = `
      import { readCodexRateLimits } from ${JSON.stringify(module)};
      const fake = ${JSON.stringify(fake('drop-stdin'))};
      readCodexRateLimits({ command: fake }).then(
        () => console.log('resolved'),
        error => console.log('rejected: ' + error.message),
      );
      setTimeout(() => console.log('alive after the round'), 1000);
    `;
    const child = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', '--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => (stdout += chunk));
    child.stderr.on('data', chunk => (stderr += chunk));

    const [code] = await new Promise<[number | null, NodeJS.Signals | null]>(resolve => child.on('exit', (c, s) => resolve([c, s])));

    assert.equal(code, 0, `exit ${code}: ${stderr}`);
    assert.deepEqual(stdout.trim().split('\n'), ['rejected: codex app-server stdin: write EPIPE', 'alive after the round']);
  });

  it('what the server says after the answer is not the protocol any more: the first answer stands, nothing is written to the ended stdin', async () => {
    assert.deepEqual(await readCodexRateLimits({ command: fake('chatty') }), CHECKED);
    // The fake lives 300 ms past its answer and repeats the handshake's
    // answer: a client still listening would write after end. Let its
    // echoes arrive before the test ends.
    await new Promise(resolve => setTimeout(resolve, 400));
  });
});

describe('rateLimitsOfResult', () => {
  it('passes a snapshot of the protocol’s shape through with every field present, the unsaid ones null; the rest of the body is dropped', () => {
    assert.deepEqual(rateLimitsOfResult({ ...RESULT, accountId: 'acc', rateLimitUpsell: { x: 1 } }), CHECKED);
    assert.deepEqual(rateLimitsOfResult({ rateLimits: {} }), {
      rateLimits: { limitId: null, limitName: null, primary: null, secondary: null, planType: null, rateLimitReachedType: null, spendControlReached: null, credits: null, individualLimit: null },
      rateLimitsByLimitId: null,
      rateLimitResetCredits: null,
    });

    const rich = rateLimitsOfResult({
      rateLimits: {
        limitId: 'codex',
        limitName: 'Codex',
        primary: { usedPercent: 10, resetsAt: null, windowDurationMins: 300 },
        secondary: { usedPercent: 63 },
        planType: 'business',
        rateLimitReachedType: 'workspace_member_usage_limit_reached',
        spendControlReached: true,
        credits: { hasCredits: true, unlimited: false },
        individualLimit: { limit: '$100', used: '$80', remainingPercent: 20, resetsAt: 1792115459 },
      },
      rateLimitsByLimitId: {},
      rateLimitResetCredits: { availableCount: 1, credits: [] },
    });

    assert.deepEqual(rich.rateLimits.primary, { usedPercent: 10, resetsAt: null, windowDurationMins: 300 });
    assert.deepEqual(rich.rateLimits.secondary, { usedPercent: 63, resetsAt: null, windowDurationMins: null });
    assert.deepEqual(rich.rateLimits.credits, { hasCredits: true, unlimited: false, balance: null });
    assert.deepEqual(rich.rateLimits.individualLimit, { limit: '$100', used: '$80', remainingPercent: 20, resetsAt: 1792115459 });
    assert.equal(rich.rateLimits.rateLimitReachedType, 'workspace_member_usage_limit_reached');
    assert.equal(rich.rateLimits.spendControlReached, true);
    assert.deepEqual(rich.rateLimitsByLimitId, {});
    assert.deepEqual(rich.rateLimitResetCredits, { availableCount: 1 });
  });

  it('refuses a body without the snapshot, and any field the console shows in another shape — named by its place', () => {
    assert.throws(() => rateLimitsOfResult(null), { message: 'account/rateLimits/read answered without a rateLimits snapshot' });
    assert.throws(() => rateLimitsOfResult({ rateLimits: 'x' }), /without a rateLimits snapshot/);
    assert.throws(() => rateLimitsOfResult({ rateLimits: [] }), /without a rateLimits snapshot/);
    assert.throws(() => rateLimitsOfResult({ rateLimits: {}, rateLimitsByLimitId: 'x' }), /malformed rateLimitsByLimitId$/);
    assert.throws(() => rateLimitsOfResult({ rateLimits: {}, rateLimitsByLimitId: { a: 'x' } }), /malformed rateLimitsByLimitId\.a$/);
    assert.throws(() => rateLimitsOfResult({ rateLimits: {}, rateLimitsByLimitId: { a: { secondary: {} } } }), /malformed rateLimitsByLimitId\.a\.secondary\.usedPercent/);
    assert.throws(() => rateLimitsOfResult({ rateLimits: { primary: { usedPercent: NaN } } }), /malformed rateLimits\.primary\.usedPercent/);
    assert.throws(() => rateLimitsOfResult({ rateLimits: { primary: { usedPercent: 1, resetsAt: '2026-10-13' } } }), /malformed rateLimits\.primary\.resetsAt/);
    assert.throws(() => rateLimitsOfResult({ rateLimits: { primary: [1] } }), /malformed rateLimits\.primary$/);
    // The nested types the card shows as strings, booleans and numbers.
    assert.throws(() => rateLimitsOfResult({ rateLimits: { planType: { name: 'pro' } } }), /malformed rateLimits\.planType/);
    assert.throws(() => rateLimitsOfResult({ rateLimits: { rateLimitReachedType: 1 } }), /malformed rateLimits\.rateLimitReachedType/);
    assert.throws(() => rateLimitsOfResult({ rateLimits: { spendControlReached: 'yes' } }), /malformed rateLimits\.spendControlReached/);
    assert.throws(() => rateLimitsOfResult({ rateLimits: { credits: {} } }), /malformed rateLimits\.credits\.hasCredits/);
    assert.throws(() => rateLimitsOfResult({ rateLimits: { credits: { hasCredits: true, unlimited: false, balance: 12.5 } } }), /malformed rateLimits\.credits\.balance/);
    assert.throws(() => rateLimitsOfResult({ rateLimits: { individualLimit: { limit: '$100', used: '$80', remainingPercent: 20 } } }), /malformed rateLimits\.individualLimit\.resetsAt/);
    assert.throws(() => rateLimitsOfResult({ rateLimits: { individualLimit: { limit: 100, used: '$80', remainingPercent: 20, resetsAt: 1 } } }), /malformed rateLimits\.individualLimit\.limit/);
    assert.throws(() => rateLimitsOfResult({ rateLimits: { limitName: ['a'] } }), /malformed rateLimits\.limitName/);
    assert.throws(() => rateLimitsOfResult({ rateLimits: {}, rateLimitResetCredits: {} }), /malformed rateLimitResetCredits\.availableCount/);
    assert.throws(() => rateLimitsOfResult({ rateLimits: {}, rateLimitResetCredits: 3 }), /malformed rateLimitResetCredits$/);
  });
});
