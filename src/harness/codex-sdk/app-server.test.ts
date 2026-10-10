// The app-server client over a fake server (a node script speaking the
// protocol on stdio): the handshake in order (initialize, `initialized`,
// the read), the checked answer, the server's error, a server that exits
// before answering (its stderr in the message), a command that cannot
// start, a round ended by its signal.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { rateLimitsOfResult, readCodexRateLimits } from './app-server.ts';

const FAKE = `
const rl = require('node:readline').createInterface({ input: process.stdin });
const mode = process.env.FAKE_MODE;
let initialized = false;
const out = m => process.stdout.write(JSON.stringify(m) + '\\n');
rl.on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') {
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
    else out({ id: m.id, result: JSON.parse(process.env.FAKE_RESULT) });
  }
});
rl.on('close', () => process.exit(0));
`;

const RESULT = {
  rateLimits: { limitId: 'codex', primary: { usedPercent: 63, windowDurationMins: 10080, resetsAt: 1792115459 }, secondary: null, planType: 'prolite' },
  rateLimitsByLimitId: { codex: { limitId: 'codex', primary: { usedPercent: 63, windowDurationMins: 10080, resetsAt: 1792115459 }, secondary: null, planType: 'prolite' } },
  rateLimitResetCredits: { availableCount: 3 },
};

function fake(mode: string) {
  return { command: process.execPath, args: ['-e', FAKE], env: { ...(process.env as Record<string, string>), FAKE_MODE: mode, FAKE_RESULT: JSON.stringify(RESULT) } };
}

describe('readCodexRateLimits', () => {
  it('initializes, announces, asks and answers the checked body; the server’s noise is ignored', async () => {
    assert.deepEqual(await readCodexRateLimits({ command: fake('ok') }), RESULT);
  });

  it('the server’s error for the request is the failure', async () => {
    await assert.rejects(readCodexRateLimits({ command: fake('error') }), { message: 'account/rateLimits/read: unauthorized (code -32000)' });
  });

  it('a server that exits before answering fails with its exit and the last line of its stderr', async () => {
    await assert.rejects(readCodexRateLimits({ command: fake('exit') }), { message: 'codex app-server exited before answering (code 3): ERROR codex_app_server: no auth' });
  });

  it('a malformed answer is a failure, not a view', async () => {
    await assert.rejects(readCodexRateLimits({ command: fake('malformed') }), { message: 'account/rateLimits/read answered with a malformed primary window' });
  });

  it('a command that cannot start fails at once', async () => {
    await assert.rejects(readCodexRateLimits({ command: { command: '/nonexistent/codex', args: ['app-server'], env: {} } }), /codex app-server could not start: spawn \/nonexistent\/codex ENOENT/);
  });

  it('the signal ends a round the server does not answer, with its reason', async () => {
    const controller = new AbortController();
    const pending = readCodexRateLimits({ command: fake('hang'), signal: controller.signal });

    setTimeout(() => controller.abort(new Error('no answer within 0.1 s')), 100);
    await assert.rejects(pending, { message: 'no answer within 0.1 s' });

    const already = new AbortController();

    already.abort(new Error('gone'));
    await assert.rejects(readCodexRateLimits({ command: fake('ok'), signal: already.signal }), { message: 'gone' });
  });
});

describe('rateLimitsOfResult', () => {
  it('passes a snapshot with numeric windows through and refuses anything else', () => {
    assert.equal(rateLimitsOfResult(RESULT), RESULT);
    assert.deepEqual(rateLimitsOfResult({ rateLimits: {} }), { rateLimits: {} });
    assert.throws(() => rateLimitsOfResult(null), { message: 'account/rateLimits/read answered without a rateLimits snapshot' });
    assert.throws(() => rateLimitsOfResult({ rateLimits: 'x' }), /without a rateLimits snapshot/);
    assert.throws(() => rateLimitsOfResult({ rateLimits: {}, rateLimitsByLimitId: 'x' }), /malformed rateLimitsByLimitId/);
    assert.throws(() => rateLimitsOfResult({ rateLimits: {}, rateLimitsByLimitId: { a: { secondary: {} } } }), /malformed secondary window/);
  });
});
