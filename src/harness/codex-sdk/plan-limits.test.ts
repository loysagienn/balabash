// The Codex limits service over fake app-server answers and a fake clock:
// the view of an answer (buckets, windows, account facts), when a
// measurement is taken (a stale read — shared, one at a time; a fresh
// cache left alone), what a read answers without a provider, with a
// failing round (its outcome, the cache kept, a warning once) and with one
// that does not answer (abandoned through its signal).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CodexRateLimitSnapshot, CodexRateLimitsResponse } from './app-server.ts';
import { FRESH_MS, createCodexPlanLimits, limitsOfRateLimits } from './plan-limits.ts';

const T0 = Date.parse('2026-10-10T16:00:00Z');

// A snapshot as the client answers it: every field present, the unsaid
// ones null.
function snapshot(partial: Partial<CodexRateLimitSnapshot> = {}): CodexRateLimitSnapshot {
  return { limitId: null, limitName: null, primary: null, secondary: null, planType: null, rateLimitReachedType: null, spendControlReached: null, credits: null, individualLimit: null, ...partial };
}

// The live answer of 2026-10-10 (a Pro Lite plan: one weekly window).
function answer(overrides: Partial<CodexRateLimitsResponse> = {}): CodexRateLimitsResponse {
  const codex = snapshot({
    limitId: 'codex',
    primary: { usedPercent: 63, windowDurationMins: 10080, resetsAt: 1792115459 },
    credits: { hasCredits: false, unlimited: false, balance: '0' },
    spendControlReached: false,
    planType: 'prolite',
  });

  return { rateLimits: codex, rateLimitsByLimitId: { codex }, rateLimitResetCredits: { availableCount: 3 }, ...overrides };
}

describe('limitsOfRateLimits', () => {
  it('one metered bucket: its windows and facts unnamed, the account facts of the snapshot', () => {
    const at = new Date(T0);

    assert.deepEqual(limitsOfRateLimits(answer(), at), {
      measuredAt: at,
      planType: 'prolite',
      windows: [{ bucket: null, kind: 'primary', windowMinutes: 10080, utilization: 63, resetsAt: new Date(1792115459 * 1000) }],
      buckets: [{ bucket: null, reached: null, spendControlReached: false, spendLimit: null }],
      credits: { has: false, unlimited: false, balance: '0' },
      resetCredits: 3,
    });
  });

  it('several buckets name their windows and facts (the name, else the id, else the key), both windows of a bucket in order; no keyed buckets — the historical snapshot', () => {
    const view = limitsOfRateLimits(
      answer({
        rateLimitsByLimitId: {
          codex: snapshot({ limitId: 'codex', primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1792115459 }, secondary: { usedPercent: 63, windowDurationMins: 10080, resetsAt: null } }),
          other: snapshot({ limitName: 'Other models', primary: { usedPercent: 5, windowDurationMins: null, resetsAt: null } }),
          third: snapshot({ primary: { usedPercent: 1, windowDurationMins: null, resetsAt: null } }),
        },
      }),
      new Date(T0),
    );

    assert.deepEqual(
      view.windows.map(w => [w.bucket, w.kind, w.windowMinutes, w.utilization, w.resetsAt?.getTime() ?? null]),
      [
        ['codex', 'primary', 300, 10, 1792115459000],
        ['codex', 'secondary', 10080, 63, null],
        ['Other models', 'primary', null, 5, null],
        ['third', 'primary', null, 1, null],
      ],
    );
    assert.deepEqual(
      view.buckets.map(b => b.bucket),
      ['codex', 'Other models', 'third'],
    );

    const historical = limitsOfRateLimits(answer({ rateLimitsByLimitId: null }), new Date(T0));

    assert.deepEqual(historical.windows.map(w => [w.bucket, w.kind]), [[null, 'primary']]);
    assert.deepEqual(historical.buckets.map(b => b.bucket), [null]);
    assert.deepEqual(limitsOfRateLimits(answer({ rateLimitsByLimitId: {} }), new Date(T0)).windows.length, 1);
  });

  it('the facts of each bucket stay its own: a refusal, the spend control and the member’s spend limit of one bucket beside another that goes through', () => {
    const view = limitsOfRateLimits(
      answer({
        rateLimits: snapshot({ limitId: 'codex', primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: null }, planType: 'business', credits: { hasCredits: true, unlimited: false, balance: '12.50' } }),
        rateLimitsByLimitId: {
          codex: snapshot({ limitId: 'codex', primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: null }, planType: 'business', rateLimitReachedType: null, spendControlReached: false }),
          other: snapshot({
            limitName: 'Other models',
            primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: null },
            rateLimitReachedType: 'workspace_member_usage_limit_reached',
            spendControlReached: true,
            individualLimit: { limit: '$100', used: '$80', remainingPercent: 20, resetsAt: 1792115459 },
          }),
        },
        rateLimitResetCredits: null,
      }),
      new Date(T0),
    );

    assert.equal(view.planType, 'business');
    assert.deepEqual(view.credits, { has: true, unlimited: false, balance: '12.50' });
    assert.deepEqual(view.buckets, [
      { bucket: 'codex', reached: null, spendControlReached: false, spendLimit: null },
      {
        bucket: 'Other models',
        reached: 'workspace_member_usage_limit_reached',
        spendControlReached: true,
        spendLimit: { used: '$80', limit: '$100', remainingPercent: 20, resetsAt: new Date(1792115459 * 1000) },
      },
    ]);
    assert.equal(view.resetCredits, null);
  });

  it('nothing said — null; a reset moment no date can hold — unknown, the rest of its window and spend limit kept', () => {
    const bare = limitsOfRateLimits({ rateLimits: snapshot(), rateLimitsByLimitId: null, rateLimitResetCredits: null }, new Date(T0));

    assert.deepEqual(bare, {
      measuredAt: new Date(T0),
      planType: null,
      windows: [],
      buckets: [{ bucket: null, reached: null, spendControlReached: null, spendLimit: null }],
      credits: null,
      resetCredits: null,
    });

    const far = limitsOfRateLimits(
      {
        rateLimits: snapshot({ primary: { usedPercent: 5, windowDurationMins: 300, resetsAt: 1e20 }, individualLimit: { limit: '$100', used: '$80', remainingPercent: 20, resetsAt: -1e20 } }),
        rateLimitsByLimitId: null,
        rateLimitResetCredits: null,
      },
      new Date(T0),
    );

    assert.deepEqual(far.windows, [{ bucket: null, kind: 'primary', windowMinutes: 300, utilization: 5, resetsAt: null }]);
    assert.deepEqual(far.buckets[0]?.spendLimit, { used: '$80', limit: '$100', remainingPercent: 20, resetsAt: null });
  });
});

describe('createCodexPlanLimits', () => {
  function stand(attemptMs?: number) {
    let clock = T0;
    const warnings: string[] = [];
    const service = createCodexPlanLimits({ now: () => clock, warn: m => warnings.push(m), attemptMs });

    return { service, warnings, tick: (ms: number) => (clock += ms) };
  }

  it('reads nothing without a provider; a stale read measures, shares one measurement, and a fresh cache is answered as it is', async () => {
    const { service, tick } = stand();

    assert.deepEqual(await service.read(), { limits: null, lastFailure: null });

    let calls = 0;
    let release: (() => void) | null = null;

    service.setProvider(() => {
      calls += 1;

      return new Promise(resolve => {
        release = () => resolve(answer());
      });
    });

    const first = service.read();
    const second = service.read();

    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(calls, 1);
    release!();

    assert.equal((await first).limits?.measuredAt.getTime(), T0);
    assert.equal((await second).limits?.windows[0]?.utilization, 63);

    tick(FRESH_MS - 1);
    await service.read();
    assert.equal(calls, 1);

    tick(1);
    const third = service.read();

    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(calls, 2);
    release!();
    assert.equal((await third).limits?.measuredAt.getTime(), T0 + FRESH_MS);

    // The provider taken away: the cache stands.
    service.setProvider(null);
    tick(FRESH_MS);
    assert.equal((await service.read()).limits?.measuredAt.getTime(), T0 + FRESH_MS);
    assert.equal(calls, 2);
  });

  it('a failing round is the outcome of the read and a warning once per message; the cache stays; the next measurement clears it', async () => {
    const { service, warnings, tick } = stand();
    let fail = true;

    service.setProvider(async () => {
      if (fail) {
        throw new Error('account/rateLimits/read: unauthorized (code 401)');
      }

      return answer();
    });

    assert.deepEqual(await service.read(), { limits: null, lastFailure: { at: new Date(T0), message: 'account/rateLimits/read: unauthorized (code 401)' } });
    tick(FRESH_MS);
    await service.read();
    assert.deepEqual(warnings, ['rate limits read failed: account/rateLimits/read: unauthorized (code 401)']);

    fail = false;
    tick(FRESH_MS);

    const measured = await service.read();

    assert.equal(measured.lastFailure, null);
    assert.equal(measured.limits?.planType, 'prolite');

    fail = true;
    tick(FRESH_MS);

    const kept = await service.read();

    assert.equal(kept.limits?.planType, 'prolite');
    assert.equal(kept.lastFailure?.at.getTime(), T0 + 3 * FRESH_MS);
    assert.equal(warnings.length, 2);
  });

  it('a round that does not answer in time is abandoned through its signal', async () => {
    const { service } = stand(20);
    let aborted: unknown = null;

    service.setProvider(
      signal =>
        new Promise((_, reject) => {
          signal.addEventListener('abort', () => {
            aborted = signal.reason;
            reject(signal.reason);
          });
        }),
    );

    const read = await service.read();

    assert.equal(read.limits, null);
    assert.equal(read.lastFailure?.message, 'no answer within 0.02 s');
    assert.ok(aborted instanceof Error);
  });
});
